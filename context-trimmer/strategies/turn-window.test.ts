/**
 * Logic test for the sticky, compaction-safe turnWindow.
 * Run with: bun run context-trimmer/strategies/turn-window.test.ts
 *
 * A turn = one or more CONSECUTIVE user messages + the assistants answering them.
 * Boundary is pinned at c-10 (keepTurns = recentFullTurns + priorTrimmedTurns).
 */
import { turnWindow } from "./turn-window"
import type { ChatMessage } from "./types"

function user(id: string): ChatMessage {
  return { info: { id, role: "user" } as any, parts: [{ id: id + "-t", type: "text", text: "q" } as any] }
}
function compactionUser(id: string): ChatMessage {
  return {
    info: { id, role: "user" } as any,
    parts: [{ id: id + "-c", type: "compaction", auto: true, tail_start_id: "tail" } as any],
  }
}
function assistantWithTools(id: string): ChatMessage {
  return {
    info: { id, role: "assistant" } as any,
    parts: [
      { id: id + "-tool", type: "tool", callID: "c", tool: "bash", state: { status: "completed", input: {}, output: "R", title: "", metadata: {}, time: { start: 0, end: 1 } } } as any,
      { id: id + "-txt", type: "text", text: "a" } as any,
    ],
  }
}
function hasTool(m: ChatMessage): boolean { return m.parts.some((p) => p.type === "tool") }
function userIds(out: ChatMessage[]): string[] { return out.filter((m) => m.info.role === "user").map((m) => m.info.id) }
function hasNotice(m: ChatMessage): boolean { return m.parts.some((p) => (p as any).id === "context-trimmer-notice") }
function anyNotice(out: ChatMessage[]): boolean { return out.some(hasNotice) }

function convo(n: number): ChatMessage[] {
  const msgs: ChatMessage[] = []
  for (let i = 1; i <= n; i++) { msgs.push(user("u" + i)); msgs.push(assistantWithTools("a" + i)) }
  return msgs
}

// ---------- Test 1: consecutive user messages merge into one turn ----------
{
  // u1,u2 are consecutive (no assistant between) -> one merged turn T0.
  // T0={u1,u2,a1}, T1={u3,a3}, T2={u4,a4}  => 3 turns.
  const msgs: ChatMessage[] = [user("u1"), user("u2"), assistantWithTools("a1"), user("u3"), assistantWithTools("a3"), user("u4"), assistantWithTools("a4")]
  // threshold 2, keepTurns 1 -> boundary at c-1 = T1(u3); T0 dropped.
  const strat = turnWindow({ threshold: 2, recentFullTurns: 1, priorTrimmedTurns: 0 })
  const out = strat.apply(msgs, { sessionID: "m" } as any)
  // If u1,u2 merged into T0, they are dropped together -> only u3,u4 remain.
  assertEq(userIds(out), ["u3", "u4"], "merge: consecutive u1,u2 form one turn, dropped atomically")
}

// ---------- Test 2: sticky boundary at c-10 ----------
{
  const strat = turnWindow({ threshold: 20, recentFullTurns: 5, priorTrimmedTurns: 5 })
  const ctx = { sessionID: "s1" } as any

  let out = strat.apply(convo(20), ctx)
  assertEq(out.length, 40, "20 turns: unchanged length")

  out = strat.apply(convo(21), ctx)
  assertEq(userIds(out), range(11, 21), "trigger: keep turns 11..21")
  assert(!hasTool(find(out, "a11")), "trigger: boundary u11 trimmed")
  assert(!hasTool(find(out, "a15")), "trigger: u15 last trimmed")
  assert(hasTool(find(out, "a16")), "trigger: u16 first full")
  assert(hasTool(find(out, "a21")), "trigger: newest full")

  for (let n = 22; n <= 30; n++) {
    out = strat.apply(convo(n), ctx)
    assertEq(userIds(out)[0], "u11", `n=${n}: boundary still u11`)
    assert(hasTool(find(out, "a" + n)), `n=${n}: newest full`)
  }

  out = strat.apply(convo(31), ctx)
  assertEq(userIds(out)[0], "u21", "re-trigger at n=31: new boundary u21")
}

// ---------- Test 3: compaction turns are treated as ordinary turns ----------
{
  const strat = turnWindow({ threshold: 20, recentFullTurns: 5, priorTrimmedTurns: 5 })
  const ctx = { sessionID: "s3" } as any
  // compaction-user at turn 3, well before the c-10 boundary -> dropped like any other.
  const msgs: ChatMessage[] = []
  for (let i = 1; i <= 35; i++) {
    if (i === 3) { msgs.push(compactionUser("comp3")); msgs.push(assistantWithTools("a3")) }
    else { msgs.push(user("u" + i)); msgs.push(assistantWithTools("a" + i)) }
  }
  const out = strat.apply(msgs, ctx)
  assert(!out.some((m) => m.info.id === "comp3"), "compaction turn before boundary is dropped (no special handling)")
}

// ---------- Test 4: stale boundary recovery ----------
{
  const strat = turnWindow({ threshold: 20, recentFullTurns: 5, priorTrimmedTurns: 5 })
  const ctx = { sessionID: "s4" } as any
  strat.apply(convo(21), ctx)
  const out = strat.apply(convo(3), ctx)
  assertEq(out.length, 6, "stale boundary: falls back to untouched")
  assert(!anyNotice(out), "no notice when not trimmed")
}

// ---------- Test 5: notice merged into the first retained user message ----------
{
  const strat = turnWindow({ threshold: 20, recentFullTurns: 5, priorTrimmedTurns: 5, notice: "TRIMMED" })
  const ctx = { sessionID: "s5" } as any
  const out = strat.apply(convo(21), ctx)
  const first = out[0]
  assertEq(first.info.role, "user", "first message is a user message")
  assertEq(first.info.id, "u11", "notice merged into first retained user (u11), no extra message")
  assert(hasNotice(first), "first user carries the notice part")
  assertEq((first.parts[0] as any).text, "TRIMMED", "notice is the first part with configured text")
  assert((first.parts[0] as any).id === "context-trimmer-notice", "notice part has stable id")
  // No standalone notice message was introduced.
  assertEq(userIds(out), range(11, 21), "no extra user message added")

  // Below threshold: untouched, no notice.
  const clean = turnWindow({ threshold: 20, recentFullTurns: 5, priorTrimmedTurns: 5, notice: "TRIMMED" }).apply(convo(20), { sessionID: "s5b" } as any)
  assert(!anyNotice(clean), "no notice below threshold")

  // Disable via empty string.
  const noNotice = turnWindow({ threshold: 20, recentFullTurns: 5, priorTrimmedTurns: 5, notice: "" }).apply(convo(21), { sessionID: "s5c" } as any)
  assert(!anyNotice(noNotice), "notice disabled with empty string")
}

// ---------- Test 6: cache-aware gate defers trigger while cache is hot ----------
{
  // Controllable clock. cacheAwareMinutes=5 -> defer trigger until idle >= 5min.
  let t = 1_000_000
  const strat = turnWindow({ threshold: 20, recentFullTurns: 5, priorTrimmedTurns: 5, cacheAwareMinutes: 5, now: () => t })
  const ctx = { sessionID: "hot" } as any

  // First request establishes lastSeen; below threshold -> untouched.
  strat.apply(convo(20), ctx)

  // 1 minute later, threshold crossed but cache still HOT -> trigger deferred.
  t += 1 * 60_000
  let out = strat.apply(convo(21), ctx)
  assertEq(out.length, 42, "cache hot: trigger deferred, conversation untouched (21 turns)")
  assert(!anyNotice(out), "cache hot: no notice while deferred")

  // Total idle 4 minutes -> still hot, still deferred.
  t += 3 * 60_000
  out = strat.apply(convo(22), ctx)
  assertEq(out.length, 44, "cache still hot at 4min: still deferred")

  // Idle >= 5 minutes since last request -> cache expired, trigger fires.
  t += 6 * 60_000
  out = strat.apply(convo(23), ctx)
  assertEq(userIds(out)[0], "u13", "cache cold: trigger fires, boundary at c-10 (u13 for n=23)")
  assert(anyNotice(out), "cache cold: notice present after trigger")
}

// ---------- Test 7: cacheAwareMinutes=0 keeps eager triggering ----------
{
  let t = 5_000_000
  const strat = turnWindow({ threshold: 20, recentFullTurns: 5, priorTrimmedTurns: 5, cacheAwareMinutes: 0, now: () => t })
  const ctx = { sessionID: "eager" } as any
  strat.apply(convo(20), ctx)
  t += 1_000 // 1 second later: cache very hot, but gate disabled
  const out = strat.apply(convo(21), ctx)
  assertEq(userIds(out)[0], "u11", "gate disabled: triggers immediately regardless of idle")
}

console.log("OK: sticky compaction-safe turnWindow behaves as specified")

// helpers
function range(a: number, b: number): string[] { const r: string[] = []; for (let i = a; i <= b; i++) r.push("u" + i); return r }
function find(out: ChatMessage[], id: string): ChatMessage { const m = out.find((x) => x.info.id === id); if (!m) { console.error("FAIL: missing", id); process.exit(1) } return m }
function assert(c: boolean, m: string) { if (!c) { console.error("FAIL:", m); process.exit(1) } }
function assertEq(a: any, b: any, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error("FAIL:", m, "\n  got:", a, "\n  exp:", b); process.exit(1) } }
