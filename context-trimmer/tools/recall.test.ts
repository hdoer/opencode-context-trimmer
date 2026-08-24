/**
 * Tests for the context_recall tool. Uses a fake opencode client so we can
 * exercise search/snippet/scope logic without a running server.
 *
 * Run: bun run context-trimmer/tools/recall.test.ts
 */
import { createRecallTool } from "./recall"

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("FAIL: " + msg)
}

// Build a fake message {info, parts} record.
function msg(id: string, role: string, parts: any[]) {
  return { info: { id, role, sessionID: parts[0]?.sessionID ?? "" }, parts }
}
function textPart(sessionID: string, text: string) {
  return { id: "p_" + Math.random().toString(36).slice(2), sessionID, type: "text", text }
}
function toolPart(sessionID: string, tool: string, input: unknown, output: string) {
  return { id: "p_" + Math.random().toString(36).slice(2), sessionID, type: "tool", tool, state: { status: "completed", input, output } }
}

// Fake client: two sessions, one is a subagent child (searched only via scope:all).
function fakeClient() {
  const sessions: Record<string, any[]> = {
    ses_main: [
      msg("m1", "user", [textPart("ses_main", "Please refactor the AuthController login flow")]),
      msg("m2", "assistant", [
        toolPart("ses_main", "edit", { file: "auth.ts" }, "patched AuthController"),
        textPart("ses_main", "Done, the login flow now validates tokens"),
      ]),
    ],
    ses_child: [
      msg("c1", "user", [textPart("ses_child", "subagent: analyze the payment webhook")]),
      msg("c2", "assistant", [textPart("ses_child", "the webhook retries on 500")]),
    ],
  }
  return {
    session: {
      // Mirror the v1 client: session id arrives as a PATH param. A test that
      // accepted the flat `{ sessionID }` form would not catch the real bug.
      async messages({ path }: any) {
        return { data: sessions[path?.id] ?? [] }
      },
      async list() {
        return { data: Object.keys(sessions).map((id) => ({ id })) }
      },
    },
  } as any
}

async function run() {
  const client = fakeClient()
  const t = createRecallTool(client)
  const ctx = { sessionID: "ses_main" } as any
  // execute() is typed to return ToolResult (string | object); our impl always
  // returns a string. Coerce for assertions.
  const run = async (args: any): Promise<string> => String(await t.execute(args, ctx))

  // 1) current scope finds text + tool parts, case-insensitive.
  {
    const out = await run({ query: "authcontroller" })
    assert(out.includes("session=ses_main"), "should hit main session")
    assert(/tool:edit/.test(out) || /login flow/.test(out), "should match tool or text part")
    assert(!out.includes("ses_child"), "current scope must not leak child session")
  }

  // 2) AND-match: all terms must appear (in the same part).
  {
    const hit = await run({ query: "login flow" })
    assert(hit.includes("session=ses_main"), "multi-term AND should still match one part")
    const miss = await run({ query: "login payment" })
    assert(miss.startsWith("No results"), "terms spread across parts must NOT match")
  }

  // 3) current scope cannot see the child (subagent) session.
  {
    const out = await run({ query: "webhook" })
    assert(out.startsWith("No results"), "webhook only exists in child session")
    assert(out.includes('scope:"all"'), "miss hint should suggest scope:all")
  }

  // 4) scope:all reaches the child session.
  {
    const out = await run({ query: "webhook", scope: "all" })
    assert(out.includes("session=ses_child"), "scope:all should find child session")
  }

  // 5) empty query is rejected.
  {
    const out = await run({ query: "   " })
    assert(out.includes("Empty query"), "blank query rejected")
  }

  console.log("OK: context_recall tool behaves as specified")
}

run().catch((e) => {
  console.error(e)
  throw e
})
