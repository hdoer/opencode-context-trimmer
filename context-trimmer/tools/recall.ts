/**
 * Tool: context_recall — retrieve conversation history that the trimmer removed.
 *
 * The turn-window strategy drops / condenses older turns from the *upstream*
 * message list to save tokens and protect the prompt cache, but opencode keeps
 * the FULL history on disk. This tool lets the model fetch that original content
 * back on demand via the opencode client API (no SQL, no file paths) — it reads
 * exactly what was trimmed away.
 *
 * Targeting one session directly:
 *   - Pass `sessionID` to search exactly that session (e.g. an id seen in an
 *     earlier result's `session=...`). It bypasses `scope` entirely and is the
 *     cheapest, most precise lookup.
 *
 * Scope (three tiers, cheapest first; used only when `sessionID` is absent):
 *   - "session" (default): only the running session. Fast and most relevant.
 *     The tool receives the live session id from its execute context, so
 *     subagents automatically search their OWN (child) session.
 *   - "project": every session in the CURRENT project (same worktree). Covers
 *     sibling conversations and subagent child sessions of this project.
 *   - "all": every session across EVERY project on this machine. This can be
 *     expensive (it may scan the entire history when nothing matches), so it is
 *     reserved for when the user explicitly asks to search across projects —
 *     e.g. "we discussed X in some other repo, find it". Never pick "all" on
 *     your own just because a narrower scope came up empty.
 *
 * How the tiers map onto the opencode client:
 *   - session: session.messages({ path: { id } }) for one id.
 *   - project: session.list() (defaults to the server's project) -> messages.
 *   - all:     project.list() -> session.list({ query: { directory } }) per
 *              project worktree -> messages.
 */
import { tool } from "@opencode-ai/plugin"
import type { PluginInput } from "@opencode-ai/plugin"

type OpencodeClient = PluginInput["client"]

/** How many characters of context to show around each match. */
const SNIPPET_RADIUS = 240
/** Cap total matches returned so a broad query cannot flood the context. */
const MAX_MATCHES = 40

interface SearchHit {
  sessionID: string
  messageID: string
  role: string
  kind: string // "text" | tool name
  text: string
}

/** Plain searchable text for a part, or "" if it carries none. */
function partText(part: any): { kind: string; text: string } {
  if (!part || typeof part !== "object") return { kind: "", text: "" }
  if (part.type === "text") return { kind: "text", text: typeof part.text === "string" ? part.text : "" }
  if (part.type === "tool") {
    const state = part.state ?? {}
    const chunks: string[] = []
    if (state.input) chunks.push(typeof state.input === "string" ? state.input : JSON.stringify(state.input))
    if (typeof state.output === "string") chunks.push(state.output)
    return { kind: `tool:${part.tool ?? "?"}`, text: chunks.join("\n") }
  }
  return { kind: "", text: "" }
}

/** Case-insensitive AND match: every whitespace-separated term must appear. */
function matches(haystack: string, terms: string[]): boolean {
  const lower = haystack.toLowerCase()
  return terms.every((t) => lower.includes(t))
}

/** Extract a readable snippet centered on the first matched term. */
function snippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase()
  let at = -1
  for (const t of terms) {
    const i = lower.indexOf(t)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) at = 0
  const start = Math.max(0, at - SNIPPET_RADIUS)
  const end = Math.min(text.length, at + SNIPPET_RADIUS)
  const core = text.slice(start, end).trim()
  return (start > 0 ? "…" : "") + core + (end < text.length ? "…" : "")
}

/** Search one session's full on-disk history. */
async function searchSession(client: OpencodeClient, sessionID: string, terms: string[]): Promise<SearchHit[]> {
  // v1 client: the session id is a PATH param (`/session/{id}/message`). The
  // flat `{ sessionID }` form is v2-only and silently leaves `{id}` unresolved,
  // so the request hits a bad URL and returns nothing.
  const res = await client.session.messages({ path: { id: sessionID } } as any)
  const messages = (res as any)?.data ?? []
  const hits: SearchHit[] = []
  for (const msg of messages) {
    const role = msg?.info?.role ?? "?"
    for (const part of msg?.parts ?? []) {
      const { kind, text } = partText(part)
      if (!text || !matches(text, terms)) continue
      hits.push({
        sessionID,
        messageID: msg?.info?.id ?? "",
        role,
        kind,
        text: snippet(text, terms),
      })
      if (hits.length >= MAX_MATCHES) return hits
    }
  }
  return hits
}

/** List every session in the current project (server's default directory). */
async function listProjectSessions(client: OpencodeClient): Promise<string[]> {
  const list = ((await client.session.list()) as any)?.data ?? []
  return list.map((s: any) => s?.id).filter(Boolean)
}

/** List every session across every project worktree on this machine. */
async function listAllSessions(client: OpencodeClient): Promise<string[]> {
  const projects = ((await client.project.list()) as any)?.data ?? []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const p of projects) {
    const directory = p?.worktree
    if (!directory) continue
    const list = ((await client.session.list({ query: { directory } } as any)) as any)?.data ?? []
    for (const s of list) {
      const id = s?.id
      if (id && !seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
  }
  return ids
}

export function createRecallTool(client: OpencodeClient) {
  return tool({
    description:
      "Retrieve earlier conversation history that context-trimmer removed from the current request. " +
      "opencode keeps the full history on disk; this returns the original text by keyword. " +
      "Use it whenever you need details from before the trimmed boundary. " +
      "Multiple space-separated words are AND-matched (case-insensitive).",
    args: {
      query: tool.schema.string().describe("Keyword(s) to search for. Space-separated words must all appear."),
      sessionID: tool.schema
        .string()
        .optional()
        .describe(
          "Search exactly this one session id (e.g. from an earlier result's `session=...`). " +
            "When set, `scope` is ignored — this is the cheapest, most precise lookup. " +
            "Use it when you already know which session holds the content.",
        ),
      scope: tool.schema
        .enum(["session", "project", "all"])
        .optional()
        .describe(
          "Ignored when `sessionID` is set. " +
            "session (default): only this session — fastest, most relevant. " +
            "project: every session in the current project (sibling + subagent child sessions). " +
            "all: every session across ALL projects on this machine — potentially expensive, " +
            "so use it ONLY when the user explicitly asks to search across projects. " +
            "Do not escalate to a wider scope on your own just because a narrower one found nothing.",
        ),
    },
    async execute(args, context) {
      const terms = args.query
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
      if (terms.length === 0) {
        return "Empty query — provide at least one keyword."
      }

      // An explicit session id is the most precise lookup; it bypasses scope.
      const targetID = args.sessionID?.trim()
      const scope = args.scope ?? "session"
      let hits: SearchHit[] = []

      if (targetID) {
        hits = await searchSession(client, targetID, terms)
      } else if (scope === "session") {
        hits = await searchSession(client, context.sessionID, terms)
      } else {
        const ids = scope === "all" ? await listAllSessions(client) : await listProjectSessions(client)
        for (const id of ids) {
          hits.push(...(await searchSession(client, id, terms)))
          if (hits.length >= MAX_MATCHES) break
        }
      }

      if (hits.length === 0) {
        const hint = targetID
          ? ` No matches in session ${targetID}.`
          : scope === "session"
            ? ' No matches in this session. Retry with scope:"project" to search the whole project.'
            : scope === "project"
              ? " No matches in this project."
              : " No matches in any project."
        return `No results for "${args.query}".${hint}`
      }

      const capped = hits.slice(0, MAX_MATCHES)
      const body = capped
        .map((h, i) => `#${i + 1} [${h.role}/${h.kind}] session=${h.sessionID} msg=${h.messageID}\n${h.text}`)
        .join("\n\n")
      const more = hits.length > capped.length ? `\n\n(showing first ${capped.length}; refine the query for fewer)` : ""
      return body + more
    },
  })
}
