/**
 * Tests for SessionContextStore, focused on `resolve()` — the session-attribution
 * fix. The transform hook has no sessionID of its own, so it must resolve context
 * by the true `info.sessionID` on the messages. A subagent runs its own turns in
 * the same process and moves the global "latest" pointer onto the CHILD session;
 * resolve() must still return the PARENT's context when given the parent's id.
 *
 * Run: bun run context-trimmer/context.test.ts
 */
import { SessionContextStore } from "./context"

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error("FAIL:", msg)
    process.exit(1)
  }
}
function assertEq(a: unknown, b: unknown, msg: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    console.error("FAIL:", msg, "\n  got:", a, "\n  exp:", b)
    process.exit(1)
  }
}

// 1) resolve by explicit session id returns THAT session's stored context.
{
  const store = new SessionContextStore()
  store.set("parent", { sessionID: "parent", modelID: "m-parent" })
  const ctx = store.resolve("parent")
  assertEq(ctx?.sessionID, "parent", "resolve returns the requested session")
  assertEq(ctx?.modelID, "m-parent", "resolve enriches with stored model info")
}

// 2) THE REGRESSION: a subagent moved the global pointer onto the child, but
//    resolving by the parent's id must still return the parent's context.
{
  const store = new SessionContextStore()
  store.set("parent", { sessionID: "parent", modelID: "m-parent" })
  store.set("child", { sessionID: "child", modelID: "m-child" }) // subagent ran last
  assertEq(store.latest()?.sessionID, "child", "precondition: latest() points at the child")

  const ctx = store.resolve("parent")
  assertEq(ctx?.sessionID, "parent", "resolve ignores latest(), returns the parent by id")
  assertEq(ctx?.modelID, "m-parent", "resolve returns the parent's model, not the child's")
}

// 3) resolve by an id that chat.params has not populated yet -> minimal context,
//    never null, so trimming can still run keyed by the correct session.
{
  const store = new SessionContextStore()
  const ctx = store.resolve("unseen")
  assertEq(ctx?.sessionID, "unseen", "resolve builds a minimal {sessionID} when unseen")
  assertEq(ctx?.modelID, undefined, "minimal context has no model info")
}

// 4) no session id at all -> fall back to latest() (only safe when there is
//    genuinely nothing to key on, e.g. an empty message list).
{
  const store = new SessionContextStore()
  assertEq(store.resolve(undefined), undefined, "no id, empty store -> undefined")
  store.set("only", { sessionID: "only", modelID: "m" })
  assertEq(store.resolve(undefined)?.sessionID, "only", "no id -> falls back to latest()")
}

console.log("OK: SessionContextStore.resolve behaves as specified")
