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
    `[context-trimmer] 较早的上下文已被裁剪，但完整历史仍完整保存，可随时检索。`,
    ``,
    `当你需要被裁剪掉的信息时，调用 context_recall 工具即可取回原文：`,
    `  - query：要找的关键词，多个词用空格分隔（大小写不敏感，须全部命中）。`,
    `  - scope：默认 "current"（只查本会话，最相关）；本会话查不到时用 "all"（跨全部会话，可覆盖 subagent 子会话）。`,
    ``,
    `无需人工确认路径或数据库位置——直接调用 context_recall 即可。`,
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
      // the cache is likely still hot (session idle below cacheAwareMinutes).
      if (activeTurns > threshold) {
        const idleMs = prevSeenMs === undefined ? Infinity : nowMs - prevSeenMs
        const cacheHot = cacheAwareMinutes > 0 && idleMs < cacheAwareMinutes * 60_000
        if (!cacheHot) {
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

      const noticeText =
        typeof noticeOption === "function"
          ? noticeOption({ sessionID, storagePath: STORAGE_PATH })
          : noticeOption
      if (noticeText) result = prependNotice(result, noticeText)
      return result
    },
  }
}
