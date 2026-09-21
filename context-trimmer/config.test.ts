/**
 * Tests for the global config loader.
 * Run: bun run context-trimmer/config.test.ts
 */
import { DEFAULT_CONFIG, loadConfig, normalize } from "./config"

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("FAIL: " + msg)
}

// 1) Defaults are sane and complete.
assert(DEFAULT_CONFIG.enabled === true, "default enabled=true")
assert(DEFAULT_CONFIG.threshold === 20, "default threshold=20")
assert(DEFAULT_CONFIG.recentFullTurns === 5, "default recentFullTurns=5")
assert(DEFAULT_CONFIG.priorTrimmedTurns === 5, "default priorTrimmedTurns=5")
assert(DEFAULT_CONFIG.cacheAwareMinutes === 5, "default cacheAwareMinutes=5 (cache-protected)")
assert(DEFAULT_CONFIG.breadcrumbUserMessages === 100, "default breadcrumbUserMessages=100")
assert(DEFAULT_CONFIG.breadcrumbMaxTokens === 100, "default breadcrumbMaxTokens=100")

// 2) normalize: a valid object passes through.
{
  const cfg = normalize({ enabled: false, threshold: 30, recentFullTurns: 8, priorTrimmedTurns: 3, cacheAwareMinutes: 5, breadcrumbUserMessages: 50, breadcrumbMaxTokens: 40 })
  assert(cfg.enabled === false, "enabled false honored")
  assert(cfg.threshold === 30, "threshold honored")
  assert(cfg.recentFullTurns === 8, "recentFullTurns honored")
  assert(cfg.priorTrimmedTurns === 3, "priorTrimmedTurns honored")
  assert(cfg.cacheAwareMinutes === 5, "cacheAwareMinutes honored")
  assert(cfg.breadcrumbUserMessages === 50, "breadcrumbUserMessages honored")
  assert(cfg.breadcrumbMaxTokens === 40, "breadcrumbMaxTokens honored")
}

// 3) normalize: non-objects and null fall back to defaults.
for (const bad of [null, undefined, 42, "x", []]) {
  assert(JSON.stringify(normalize(bad)) === JSON.stringify(DEFAULT_CONFIG), "bad root -> defaults: " + JSON.stringify(bad))
}

// 4) normalize: per-field validation — one bad field doesn't poison the rest.
{
  const cfg = normalize({ enabled: "yes", threshold: -5, recentFullTurns: 2.9, priorTrimmedTurns: "x" })
  assert(cfg.enabled === DEFAULT_CONFIG.enabled, "non-bool enabled -> default")
  assert(cfg.threshold === DEFAULT_CONFIG.threshold, "threshold < 1 -> default")
  assert(cfg.recentFullTurns === 2, "2.9 floored to 2")
  assert(cfg.priorTrimmedTurns === DEFAULT_CONFIG.priorTrimmedTurns, "non-number -> default")
}

// 5) normalize: zero kept turns is allowed (disables trimming via keepTurns<=0).
{
  const cfg = normalize({ recentFullTurns: 0, priorTrimmedTurns: 0 })
  assert(cfg.recentFullTurns === 0 && cfg.priorTrimmedTurns === 0, "zero kept turns allowed")
}

// 6) loadConfig never throws and always returns a complete config.
{
  const cfg = loadConfig()
  assert(typeof cfg.enabled === "boolean", "enabled is boolean")
  assert(Number.isInteger(cfg.threshold) && cfg.threshold >= 1, "threshold is a positive int")
  assert(Number.isInteger(cfg.recentFullTurns) && cfg.recentFullTurns >= 0, "recentFullTurns >= 0")
  assert(Number.isInteger(cfg.priorTrimmedTurns) && cfg.priorTrimmedTurns >= 0, "priorTrimmedTurns >= 0")
  assert(JSON.stringify(cfg) === JSON.stringify(loadConfig()), "repeated loads are consistent")
}

console.log("OK: config loader behaves as specified")
