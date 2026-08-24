/**
 * Strategy contract.
 *
 * A strategy is a small, self-contained unit that decides whether it applies to
 * the current request and, if so, returns a transformed message list. Strategies
 * are pure functions of (messages, context): they must not mutate the input
 * array — return a new array (or the same reference untouched) instead.
 */
import type { Message, Part } from "@opencode-ai/sdk"
import type { SessionContext } from "../context"

/** One entry in `output.messages` for the transform hook. */
export interface ChatMessage {
  info: Message
  parts: Part[]
}

/** Read-only view of the current request the strategy is acting on. */
export type StrategyContext = SessionContext

export interface Strategy {
  /** Stable identifier, used for logging/ordering. */
  readonly name: string

  /**
   * Whether this strategy should run for the current request. This is the
   * "condition" — e.g. only for a given model, above a token threshold, etc.
   */
  enabled(ctx: StrategyContext): boolean

  /**
   * Transform the messages. Must not mutate the `messages` array or its entries;
   * return the desired list instead (returning `messages` unchanged is a valid
   * no-op). A strategy MAY keep internal cross-request state (e.g. a pinned trim
   * boundary) — that state should be keyed by `ctx.sessionID`.
   */
  apply(messages: ChatMessage[], ctx: StrategyContext): ChatMessage[]
}
