/**
 * Per-session context captured from `chat.params`.
 *
 * `experimental.chat.messages.transform` receives an empty input, so we bridge
 * the model/provider information through here, keyed by session.
 */
import type { Model } from "@opencode-ai/sdk"

export interface SessionContext {
  sessionID: string
  agent?: string
  providerID?: string
  modelID?: string
  /** Full model object, when available — carries limits/capabilities. */
  model?: Model
}

export class SessionContextStore {
  private readonly bySession = new Map<string, SessionContext>()
  private lastSessionID?: string

  set(sessionID: string, ctx: SessionContext): void {
    this.bySession.set(sessionID, ctx)
    this.lastSessionID = sessionID
  }

  get(sessionID: string): SessionContext | undefined {
    return this.bySession.get(sessionID)
  }

  /**
   * Best-effort "current" context. The transform hook has no sessionID, so we
   * fall back to the most recently seen one. In practice a turn's `chat.params`
   * fires immediately before its `messages.transform`, so this is reliable for
   * sequential turns.
   */
  latest(): SessionContext | undefined {
    if (!this.lastSessionID) return undefined
    return this.bySession.get(this.lastSessionID)
  }
}
