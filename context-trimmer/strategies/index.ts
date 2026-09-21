/**
 * Strategy registry — the ONLY place to wire a new strategy in.
 *
 * To add a capability:
 *   1. create `./<my-strategy>.ts` exporting a `Strategy`
 *   2. add it to the array below
 * The plugin entry and pipeline never change.
 *
 * Order matters: strategies run top-to-bottom, each seeing the previous one's
 * output.
 */
import type { Strategy } from "./types"
import { turnWindow } from "./turn-window"
import { loadConfig } from "../config"

export const strategies: readonly Strategy[] = [
  // Parameters are read live from the user config file on every request, so
  // threshold / kept-turn edits take effect immediately (the master on/off
  // switch is handled earlier, in the plugin entry).
  turnWindow(() => {
    const cfg = loadConfig()
    return {
      threshold: cfg.threshold,
      recentFullTurns: cfg.recentFullTurns,
      priorTrimmedTurns: cfg.priorTrimmedTurns,
      cacheAwareMinutes: cfg.cacheAwareMinutes,
      breadcrumbUserMessages: cfg.breadcrumbUserMessages,
      breadcrumbMaxTokens: cfg.breadcrumbMaxTokens,
    }
  }),
]
