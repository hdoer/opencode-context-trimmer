/**
 * Global configuration for context-trimmer.
 *
 * The user controls the plugin through a single JSON file. It is the source of
 * truth for the master on/off switch and the trimming parameters. Edits take
 * effect on the next request — no restart needed.
 *
 * Location (config dir, not the data dir):
 *   $XDG_CONFIG_HOME/opencode/context-trimmer.json
 *   ~/.config/opencode/context-trimmer.json   (default)
 *
 * Robustness: a missing or malformed file is NOT an error — we fall back to the
 * built-in defaults so the plugin always behaves predictably. Per-field
 * validation means one bad field cannot poison the rest.
 *
 * Cheap to call every request: we stat the file and reuse the parsed result
 * unless its mtime changed.
 */

// Node globals/modules are declared ambiently in ./globals.d.ts.
import { readFileSync, statSync } from "node:fs"

export interface TrimmerConfig {
  /** Master switch. When false, the plugin leaves every request untouched. */
  enabled: boolean
  /** (Re)trigger trimming once active turns exceed this. */
  threshold: number
  /** Most recent turns kept in full (users + tool loop + final output). */
  recentFullTurns: number
  /** Turns before the full window kept as users + final assistant output only. */
  priorTrimmedTurns: number
  /**
   * Cache-aware gate (minutes). Only (re)trigger trimming after the session has
   * been idle at least this long, by which point the upstream prompt cache
   * (typically ~5-minute TTL) has expired — so reshaping the prefix costs no
   * extra cache miss. Defaults to 5 so an active conversation never pays for a
   * trim-induced cache miss. Set to 0 to trim as soon as the threshold hits.
   */
  cacheAwareMinutes: number
  /**
   * How many of the MOST RECENT user messages from the dropped region (turns
   * before the kept window) to preserve as short "breadcrumbs", so the agent
   * still has a trail of what was discussed earlier. Set to 0 to disable.
   */
  breadcrumbUserMessages: number
  /**
   * Max tokens kept per breadcrumb user message. Estimated as ~3.5 UTF-8 bytes
   * per token; the text is cut at the character whose inclusion first exceeds
   * that byte budget (never splitting a character), with an ellipsis appended if
   * truncated.
   */
  breadcrumbMaxTokens: number
}

export const DEFAULT_CONFIG: TrimmerConfig = {
  enabled: true,
  threshold: 20,
  recentFullTurns: 5,
  priorTrimmedTurns: 5,
  cacheAwareMinutes: 5,
  breadcrumbUserMessages: 100,
  breadcrumbMaxTokens: 100,
}

const CONFIG_PATH =
  (process.env.XDG_CONFIG_HOME || `${process.env.HOME ?? "~"}/.config`) + "/opencode/context-trimmer.json"

/** Coerce one field to a non-negative integer, falling back to the default. */
function intField(value: unknown, fallback: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  const n = Math.floor(value)
  return n < min ? fallback : n
}

/** Validate an arbitrary parsed object into a complete, safe config. */
export function normalize(raw: unknown): TrimmerConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_CONFIG
  const o = raw as Record<string, unknown>
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_CONFIG.enabled,
    threshold: intField(o.threshold, DEFAULT_CONFIG.threshold, 1),
    recentFullTurns: intField(o.recentFullTurns, DEFAULT_CONFIG.recentFullTurns, 0),
    priorTrimmedTurns: intField(o.priorTrimmedTurns, DEFAULT_CONFIG.priorTrimmedTurns, 0),
    cacheAwareMinutes: intField(o.cacheAwareMinutes, DEFAULT_CONFIG.cacheAwareMinutes, 0),
    breadcrumbUserMessages: intField(o.breadcrumbUserMessages, DEFAULT_CONFIG.breadcrumbUserMessages, 0),
    breadcrumbMaxTokens: intField(o.breadcrumbMaxTokens, DEFAULT_CONFIG.breadcrumbMaxTokens, 0),
  }
}

let cache: { mtimeMs: number; config: TrimmerConfig } | undefined

/**
 * Load the live config. Reuses the cached parse while the file's mtime is
 * unchanged; on a missing/invalid file returns defaults without caching, so a
 * freshly created or fixed file is picked up on the very next request.
 */
export function loadConfig(): TrimmerConfig {
  try {
    const { mtimeMs } = statSync(CONFIG_PATH)
    if (cache && cache.mtimeMs === mtimeMs) return cache.config
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
    const config = normalize(parsed)
    cache = { mtimeMs, config }
    return config
  } catch {
    return DEFAULT_CONFIG
  }
}
