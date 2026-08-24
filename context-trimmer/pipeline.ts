/**
 * Pipeline: run enabled strategies in order, threading the message list through
 * each. A strategy that throws is skipped (fail-open) so a buggy strategy can
 * never break the request — trimming is best-effort.
 */
import type { ChatMessage, Strategy, StrategyContext } from "./strategies/types"

export function runStrategies(
  messages: ChatMessage[],
  ctx: StrategyContext,
  strategies: readonly Strategy[],
): ChatMessage[] {
  return strategies.reduce<ChatMessage[]>((current, strategy) => {
    let enabled = false
    try {
      enabled = strategy.enabled(ctx)
    } catch {
      return current
    }
    if (!enabled) return current

    try {
      const next = strategy.apply(current, ctx)
      return Array.isArray(next) ? next : current
    } catch {
      // Fail open: keep the pre-strategy messages.
      return current
    }
  }, messages)
}
