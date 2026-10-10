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

// Fake client modelling three data tiers:
//   - ses_main / ses_child live in the CURRENT project (worktree /proj/a).
//     ses_child is a subagent child — reachable via scope:project, not session.
//   - ses_other lives in ANOTHER project (worktree /proj/b) — reachable only
//     via scope:all.
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
    ses_other: [
      msg("o1", "user", [textPart("ses_other", "line MySQL version is 8.4 in production")]),
      msg("o2", "assistant", [textPart("ses_other", "noted, MySQL 8.4 supports MEMBER OF")]),
    ],
  }
  const byProject: Record<string, string[]> = {
    "/proj/a": ["ses_main", "ses_child"],
    "/proj/b": ["ses_other"],
  }
  return {
    project: {
      async list() {
        return { data: [{ id: "pa", worktree: "/proj/a" }, { id: "pb", worktree: "/proj/b" }] }
      },
    },
    session: {
      // Mirror the v1 client: session id arrives as a PATH param. A test that
      // accepted the flat `{ sessionID }` form would not catch the real bug.
      async messages({ path }: any) {
        return { data: sessions[path?.id] ?? [] }
      },
      // No directory -> current project (/proj/a). With a directory query ->
      // that project's sessions (how scope:all walks every worktree).
      async list(opts?: any) {
        const dir = opts?.query?.directory
        const ids = dir ? (byProject[dir] ?? []) : byProject["/proj/a"]
        return { data: ids.map((id) => ({ id })) }
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

  // 1) session scope (default) finds text + tool parts, case-insensitive.
  {
    const out = await run({ query: "authcontroller" })
    assert(out.includes("session=ses_main"), "should hit main session")
    assert(/tool:edit/.test(out) || /login flow/.test(out), "should match tool or text part")
    assert(!out.includes("ses_child"), "session scope must not leak child session")
  }

  // 2) AND-match: all terms must appear (in the same part).
  {
    const hit = await run({ query: "login flow" })
    assert(hit.includes("session=ses_main"), "multi-term AND should still match one part")
    const miss = await run({ query: "login payment" })
    assert(miss.startsWith("No results"), "terms spread across parts must NOT match")
  }

  // 3) session scope cannot see the child (subagent) session.
  {
    const out = await run({ query: "webhook" })
    assert(out.startsWith("No results"), "webhook only exists in child session")
    assert(out.includes('scope:"project"'), "miss hint should suggest scope:project")
  }

  // 4) project scope reaches the subagent child session (same project).
  {
    const out = await run({ query: "webhook", scope: "project" })
    assert(out.includes("session=ses_child"), "scope:project should find child session")
  }

  // 5) project scope must NOT reach another project's session.
  {
    const out = await run({ query: "mysql", scope: "project" })
    assert(out.startsWith("No results"), "scope:project must not see other projects")
  }

  // 6) all scope reaches a session in another project.
  {
    const out = await run({ query: "mysql", scope: "all" })
    assert(out.includes("session=ses_other"), "scope:all should find other-project session")
  }

  // 7) explicit sessionID targets exactly that session, bypassing scope.
  {
    const out = await run({ query: "mysql", sessionID: "ses_other" })
    assert(out.includes("session=ses_other"), "sessionID should hit the targeted session directly")
    const miss = await run({ query: "webhook", sessionID: "ses_other" })
    assert(miss.startsWith("No results"), "sessionID limits search to that one session")
    assert(miss.includes("ses_other"), "miss hint should name the targeted session")
  }

  // 8) empty query is rejected.
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
