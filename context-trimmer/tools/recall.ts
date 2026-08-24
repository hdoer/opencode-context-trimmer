/**
 * Tool: context_recall — retrieve conversation history that the trimmer removed.
 *
 * The turn-window strategy drops / condenses older turns from the *upstream*
 * message list to save tokens and protect the prompt cache, but opencode keeps
 * the FULL history on disk. This tool lets the model fetch that original content
 * back on demand via the opencode client API (no SQL, no file paths) — it reads
 * exactly what was trimmed away.
 *
 * Scope:
 *   - "current" (default): search only the running session. Fast and most
 *     relevant. The tool receives the live session id from its execute context,
 *     so subagents automatically search their OWN (child) session.
 *   - "all": search every session (covers subagent child sessions and other
 *     conversations). Use only when "current" turns up nothing.
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

export function createRecallTool(client: OpencodeClient) {
  return tool({
    description:
      "Retrieve earlier conversation history that context-trimmer removed from the current request. " +
      "opencode keeps the full history on disk; this returns the original text by keyword. " +
      "Use it whenever you need details from before the trimmed boundary. " +
      "Multiple space-separated words are AND-matched (case-insensitive).",
    args: {
      query: tool.schema.string().describe("Keyword(s) to search for. Space-separated words must all appear."),
      scope: tool.schema
        .enum(["current", "all"])
        .optional()
        .describe(
          "current (default): only this session — fastest, most relevant. all: every session, covers subagent child sessions; use only if current finds nothing.",
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

      const scope = args.scope ?? "current"
      let hits: SearchHit[] = []

      if (scope === "all") {
        const list = ((await client.session.list()) as any)?.data ?? []
        for (const s of list) {
          const id = s?.id
          if (!id) continue
          hits.push(...(await searchSession(client, id, terms)))
          if (hits.length >= MAX_MATCHES) break
        }
      } else {
        hits = await searchSession(client, context.sessionID, terms)
      }

      if (hits.length === 0) {
        const hint =
          scope === "current"
            ? ' No matches in this session. Retry with scope:"all" to also search subagent child sessions.'
            : " No matches in any session."
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
