/**
 * Strategy: sticky turn-window trimming (cache-aware).
 *
 * Conversation model (opencode): the message list is a flat sequence of `user`
 * and `assistant` messages (the system prompt is NOT here). A "turn" is one or
 * more consecutive user messages plus every assistant message that follows them
 * until the next user message. Consecutive user messages are MERGED into a
 * single turn — this absorbs mid-turn "queued" user messages (and compaction's
 * synthetic user messages) so a single interaction is not over-split.
 *
 * An assistant turn's `parts` may contain a tool loop (`tool` parts, each
 * carrying BOTH the call input and its result output) and a final textual answer
 * (`text` parts).
 *
 * Sticky boundary (cache-aware): recomputing the window every request would
 * slide the cut boundary forward each turn and bust the upstream prompt cache.
 * Instead we PIN a boundary at c-10 and keep it stable until the active turn
 * count exceeds `threshold` again, at which point it jumps forward.
 *
 *   - When active turns (turns at/after the current boundary) first exceed
 *     `threshold`, trigger: pin the boundary at c-10 = `keepTurns` turns back
 *     from the latest turn `c`. The oldest `priorTrimmedTurns` kept turns are
 *     trimmed to their final assistant output; the newest `recentFullTurns`
 *     stay full. Everything before the boundary is dropped.
 *   - Subsequent turns append to the full region without moving the boundary,
 *     so the serialized prefix stays byte-stable and the prompt cache survives.
 *   - Re-trigger jumps the boundary forward rather than sliding it.
 *
 * Dropping `tool` parts is safe because a ToolPart is self-contained (call +
 * result in one part), so no orphaned tool_use/tool_result pairing is created.
 */
import type { Message, Part } from "@opencode-ai/sdk"
import type { ChatMessage, Strategy, StrategyContext } from "./types"

export interface TurnWindowOptions {
  /** (Re)trigger once active turns exceed this. */
  threshold: number
  /** Most recent turns kept in full (users + tool loop + final output). */
  recentFullTurns: number
  /** Turns before the full window kept as users + final assistant output only. */
  priorTrimmedTurns: number
  /**
   * Cache-aware gate. Only (re)trigger trimming after the session has been idle
   * at least this many minutes — by then the upstream prompt cache (typically a
   * 5-minute TTL) has expired, so changing the prefix costs no extra cache miss.
   * While the cache is still "hot" (idle below this), triggering is DEFERRED so
   * an active conversation is not penalized. 0 (default) disables the gate:
   * trimming triggers as soon as the turn threshold is hit.
   *
   * Note: only trigger/re-trigger changes the prefix; the sticky stable period
   * never busts the cache, so this gate only guards those boundary jumps.
   */
  cacheAwareMinutes?: number
  /**
   * Hard safety cap (in active turns) that overrides the cache-aware gate.
   *
   * The gate defers a (re)trigger while the session stays "hot" (idle below
   * cacheAwareMinutes). During CONTINUOUS work — every request lands within that
   * window — the gate would defer forever, so the pinned boundary never advances
   * and the kept region grows one turn per request without bound, eventually
   * overflowing the model context window. This cap breaks that loop: once active
   * turns exceed it, the boundary jumps even while the cache is hot (accepting one
   * cache miss to avoid a hard context-window overflow). Defaults to
   * `threshold * 2` when unset/<=0.
   */
  hardTriggerTurns?: number
  /**
   * How many of the MOST RECENT user messages from the DROPPED region (turns
   * before the boundary) to preserve as short "breadcrumbs" so the agent keeps a
   * trail of what was discussed earlier. 0 disables breadcrumbs.
   */
  breadcrumbUserMessages?: number
  /**
   * Max tokens kept per breadcrumb user message. Estimated as ~3.5 UTF-8 bytes
   * per token; text is cut at the character whose inclusion first exceeds that
   * byte budget (never splitting a character), with an ellipsis appended if
   * truncated.
   */
  breadcrumbMaxTokens?: number
  /** Only run for these model IDs. Empty/omitted = all models. */
  onlyModels?: string[]
  /**
   * Notice merged into the first retained user message whenever trimming is
   * active, telling the model that context was trimmed. Either a fixed string or
   * a builder given the session info. Set to "" to disable.
   */
  notice?: string | ((info: NoticeInfo) => string)
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number
}

export interface NoticeInfo {
  sessionID: string
  /** Absolute path to opencode's on-disk session storage directory. */
  storagePath: string
}

// Minimal ambient declaration so we can read env without pulling in @types/node.
// (process/node:fs are declared ambiently in ../globals.d.ts.)

/**
 * opencode's storage directory (the readable JSON mirror of sessions). The data
 * dir is `xdgData/opencode` and is NOT env-overridable (only the config dir is),
 * so within a running process it is fixed: `XDG_DATA_HOME || ~/.local/share` +
 * `/opencode/storage`.
 */
const STORAGE_PATH =
  (process.env.XDG_DATA_HOME || `${process.env.HOME ?? "~"}/.local/share`) + "/opencode/storage"

const DEFAULT_NOTICE = (info: NoticeInfo): string =>
  [
    `[context-trimmer] Earlier context has been trimmed, but the full history is still saved in full and can be searched anytime.`,
    ``,
    `When you need the trimmed-away information, call the context_recall tool to fetch the original text:`,
    `  - query: keywords to search for; space-separated words are AND-matched (case-insensitive).`,
    `  - scope: where to search — a keyword or a session id. "session" (default): this session only, fastest and most relevant. "project": every session in the current project (including subagent child sessions). "all": every session across all projects on the machine — expensive, use ONLY when the user explicitly asks to search across projects, don't escalate on your own. Or pass a session id (e.g. a session=... from an earlier result) to search exactly that one session.`,
    ``,
    `No need to confirm any path or database location — just call context_recall.`,
  ].join("\n")

/** One or more consecutive user messages and the assistant messages answering them. */
interface Turn {
  users: ChatMessage[]
  assistants: ChatMessage[]
}

/** Pinned trim state for one session. */
interface TrimState {
  /** Turn id (first message id of the turn) of the cut boundary. */
  boundaryId: string
  /** How many turns starting at the boundary are trimmed to final output. */
  trimmedCount: number
}

function isUser(message: ChatMessage): boolean {
  return message.info?.role === "user"
}

function isText(part: Part): boolean {
  return part.type === "text"
}

/** Stable id used to locate a turn across requests. */
function turnId(turn: Turn): string {
  return (turn.users[0] ?? turn.assistants[0])?.info?.id ?? ""
}

/**
 * Split the flat message list into turns, MERGING consecutive user messages
 * into a single turn.
 */
function partitionTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null

  for (const message of messages) {
    if (isUser(message)) {
      // Adjacent user (no assistant since the last user) -> merge into current.
      if (current && current.assistants.length === 0 && current.users.length > 0) {
        current.users.push(message)
      } else {
        current = { users: [message], assistants: [] }
        turns.push(current)
      }
    } else {
      if (!current) {
        current = { users: [], assistants: [] }
        turns.push(current)
      }
      current.assistants.push(message)
    }
  }
  return turns
}

/** Keep the user message(s) plus only the final assistant text output. */
function trimToFinalOutput(turn: Turn): ChatMessage[] {
  const out: ChatMessage[] = [...turn.users]

  const lastAssistant = turn.assistants[turn.assistants.length - 1]
  if (!lastAssistant) return out

  const textParts = lastAssistant.parts.filter(isText)
  if (textParts.length === 0) return out

  out.push({ info: lastAssistant.info as Message, parts: textParts })
  return out
}

function flattenTurn(turn: Turn): ChatMessage[] {
  return [...turn.users, ...turn.assistants]
}

/** Concatenated text of a message's text parts. */
function messageText(message: ChatMessage): string {
  return message.parts
    .filter(isText)
    .map((p) => (p as unknown as { text?: string }).text ?? "")
    .join(" ")
    .trim()
}

// A "word" is either a single CJK/Kana/Hangul character or a run of
// non-whitespace non-CJK characters, so Chinese needs no segmentation.
const encoder = new TextEncoder()

/** Rough token→byte estimate: ~3.5 UTF-8 bytes per token. */
const BYTES_PER_TOKEN = 3.5

/**
 * Truncate text to at most `maxTokens` tokens (estimated as ~3.5 UTF-8 bytes per
 * token). Cuts at the character whose inclusion would first exceed the byte
 * budget (never splitting a character) and appends an ellipsis if anything was
 * dropped.
 */
function truncateToTokens(text: string, maxTokens: number): string {
  const t = text.trim()
  if (maxTokens <= 0 || t === "") return ""
  const maxBytes = Math.floor(maxTokens * BYTES_PER_TOKEN)
  if (maxBytes <= 0) return ""
  if (encoder.encode(t).length <= maxBytes) return t
  let bytes = 0
  let out = ""
  for (const ch of t) {
    const chBytes = encoder.encode(ch).length
    if (bytes + chBytes > maxBytes) break
    bytes += chBytes
    out += ch
  }
  return out + " …"
}

/**
 * From the dropped region (turns before the boundary), take the most recent
 * `maxMessages` user messages and truncate each to `maxTokens` tokens. Returns
 * the breadcrumb lines in chronological order.
 */
function collectBreadcrumbs(droppedTurns: Turn[], maxMessages: number, maxTokens: number): string[] {
  if (maxMessages <= 0 || maxTokens <= 0) return []
  const users: ChatMessage[] = []
  for (const turn of droppedTurns) users.push(...turn.users)
  return users
    .slice(-maxMessages)
    .map((u) => truncateToTokens(messageText(u), maxTokens))
    .filter((s) => s !== "")
}

/** Assemble the breadcrumb block prepended ahead of the trim notice. */
function breadcrumbBlock(lines: string[]): string {
  return [
    `[context-trimmer] Summaries of earlier user messages that were trimmed (each truncated, as recall hints only):`,
    ...lines.map((line, i) => `  ${i + 1}. ${line}`),
  ].join("\n")
}

/**
 * Prepend the trim notice as a synthetic text part on the FIRST user message of
 * the given list. This avoids introducing a second adjacent user message (which
 * some upstreams dislike) and never fabricates an assistant reply. The notice
 * text is constant, so a stable boundary keeps the serialized prefix byte-stable
 * (cache friendly). Returns a new array; the original messages are not mutated.
 */
function prependNotice(messages: ChatMessage[], text: string): ChatMessage[] {
  const firstUserIndex = messages.findIndex(isUser)
  if (firstUserIndex < 0) return messages

  const target = messages[firstUserIndex]
  const noticePart = {
    id: "context-trimmer-notice",
    type: "text",
    text,
  } as unknown as Part

  const patched: ChatMessage = {
    info: target.info,
    parts: [noticePart, ...target.parts],
  }

  const out = messages.slice()
  out[firstUserIndex] = patched
  return out
}

/**
 * `options` may be a fixed object OR a getter re-read on every request. The
 * getter form lets user config changes (threshold / kept turns) take effect live
 * without recreating the strategy — crucial because the per-session sticky
 * boundary lives in this closure and must survive config edits.
 */
export function turnWindow(options: TurnWindowOptions | (() => TurnWindowOptions)): Strategy {
  const resolve = typeof options === "function" ? options : () => options

  // Per-session pinned boundary. Persists across requests for the plugin's life.
  const states = new Map<string, TrimState>()
  // Per-session timestamp of the previous request, for the cache-aware gate.
  const lastSeen = new Map<string, number>()

  return {
    name: "turn-window",

    enabled(ctx: StrategyContext): boolean {
      const { recentFullTurns, priorTrimmedTurns, onlyModels } = resolve()
      if (recentFullTurns + priorTrimmedTurns <= 0) return false
      if (onlyModels && onlyModels.length > 0) {
        return !!ctx.modelID && onlyModels.includes(ctx.modelID)
      }
      return true
    },

    apply(messages: ChatMessage[], ctx: StrategyContext): ChatMessage[] {
      const opts = resolve()
      const { threshold, recentFullTurns, priorTrimmedTurns } = opts
      const keepTurns = recentFullTurns + priorTrimmedTurns
      const noticeOption = opts.notice ?? DEFAULT_NOTICE
      const cacheAwareMinutes = opts.cacheAwareMinutes ?? 0
      const hardTriggerTurns = opts.hardTriggerTurns && opts.hardTriggerTurns > 0 ? opts.hardTriggerTurns : threshold * 2
      const breadcrumbUserMessages = opts.breadcrumbUserMessages ?? 0
      const breadcrumbMaxTokens = opts.breadcrumbMaxTokens ?? 0
      const now = opts.now ?? Date.now

      const turns = partitionTurns(messages)
      if (turns.length === 0) return messages

      const sessionID = ctx.sessionID || "__default__"
      // Idle gap since the previous request for this session, then refresh the
      // clock for next time. Read BEFORE updating so the gate sees the real gap.
      const nowMs = now()
      const prevSeenMs = lastSeen.get(sessionID)
      lastSeen.set(sessionID, nowMs)

      let state = states.get(sessionID)

      // Locate the current boundary. If the pinned turn is gone (e.g. after a
      // compaction reshuffles ids), drop stale state and behave as never triggered.
      let boundaryIndex = 0
      if (state) {
        const idx = turns.findIndex((t) => turnId(t) === state!.boundaryId)
        if (idx < 0) {
          states.delete(sessionID)
          state = undefined
        } else {
          boundaryIndex = idx
        }
      }

      // Active turns = turns at/after the current boundary.
      const activeTurns = turns.length - boundaryIndex

      // (Re)trigger: pin a fresh boundary at c-10. Both the first trigger and a
      // re-trigger jump the boundary and change the serialized prefix, busting
      // the upstream prompt cache. The cache-aware gate defers that jump while
      // the cache is likely still hot (session idle below cacheAwareMinutes) —
      // EXCEPT when active turns have grown past the hard cap, where deferring
      // further would risk a context-window overflow, so we jump regardless.
      if (activeTurns > threshold) {
        const idleMs = prevSeenMs === undefined ? Infinity : nowMs - prevSeenMs
        const cacheHot = cacheAwareMinutes > 0 && idleMs < cacheAwareMinutes * 60_000
        const hardOverflow = activeTurns > hardTriggerTurns
        if (!cacheHot || hardOverflow) {
          const currentIndex = turns.length - 1 // c
          const newBoundary = Math.max(0, currentIndex - keepTurns)
          state = { boundaryId: turnId(turns[newBoundary]), trimmedCount: priorTrimmedTurns }
          states.set(sessionID, state)
          boundaryIndex = newBoundary
        }
      }

      // Never triggered yet -> leave the conversation untouched.
      if (!state) return messages

      const trimmedEnd = boundaryIndex + state.trimmedCount
      let result: ChatMessage[] = []
      turns.forEach((turn, index) => {
        if (index < boundaryIndex) return // before boundary -> dropped
        if (index < trimmedEnd) result.push(...trimToFinalOutput(turn))
        else result.push(...flattenTurn(turn))
      })

      const breadcrumbs = collectBreadcrumbs(
        turns.slice(0, boundaryIndex),
        breadcrumbUserMessages,
        breadcrumbMaxTokens,
      )

      const noticeText =
        typeof noticeOption === "function"
          ? noticeOption({ sessionID, storagePath: STORAGE_PATH })
          : noticeOption
      const prefix = [breadcrumbs.length > 0 ? breadcrumbBlock(breadcrumbs) : "", noticeText]
        .filter((s) => s)
        .join("\n\n")
      if (prefix) result = prependNotice(result, prefix)
      return result
    },
  }
}
