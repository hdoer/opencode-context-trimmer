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
   * Last-resort "current" context, used ONLY when no message carries a session
   * id. The transform hook resolves context by the true `info.sessionID` on the
   * messages and enriches it via `get()`; this global-most-recent fallback is
   * unreliable under interleaved sessions (e.g. a subagent moves the pointer onto
   * the child session), so it must not be the primary lookup.
   */
  latest(): SessionContext | undefined {
    if (!this.lastSessionID) return undefined
    return this.bySession.get(this.lastSessionID)
  }

  /**
   * Resolve the context for a request, given the session id carried on its
   * messages. This is the correct primary lookup for the transform hook:
   *
   *   - `sessionID` present  -> return the stored context for THAT session (so a
   *     subagent cannot hijack the parent's context), or a minimal `{ sessionID }`
   *     if chat.params has not populated it yet.
   *   - `sessionID` absent    -> fall back to `latest()` (only safe when there is
   *     genuinely no session id to key on, e.g. an empty message list).
   */
  resolve(sessionID: string | undefined): SessionContext | undefined {
    if (sessionID) return this.bySession.get(sessionID) ?? { sessionID }
    return this.latest()
  }
}
