/**
 * Thin, fail-safe logger over opencode's `client.app.log`.
 *
 * Why not console.log: opencode's log FILE (`~/.local/share/opencode/log/
 * opencode.log`) only captures the app's structured logger — a plugin's
 * console.log goes to stdout (and is swallowed under the TUI). `client.app.log`
 * writes into that same file, tagged with a `service` so it is greppable:
 *
 *   grep context-trimmer ~/.local/share/opencode/log/opencode.log
 *
 * Logging must never break a request, so every call is fire-and-forget and
 * swallows both synchronous throws and async rejections.
 */
import type { PluginInput } from "@opencode-ai/plugin"

type OpencodeClient = PluginInput["client"]
type Level = "debug" | "info" | "warn" | "error"

const SERVICE = "context-trimmer"

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

export function createLogger(client: OpencodeClient): Logger {
  const send = (level: Level, message: string, extra?: Record<string, unknown>): void => {
    try {
      // opencode's structured logger does not render the `service` field, so a
      // `grep service=context-trimmer` finds nothing. Prefix the message itself
      // so the logs are actually greppable:  grep "[context-trimmer]" opencode.log
      const prefixed = `[${SERVICE}] ${message}`
      const p = client.app.log({ body: { service: SERVICE, level, message: prefixed, extra } } as any)
      if (p && typeof (p as any).catch === "function") (p as any).catch(() => {})
    } catch {
      // Never let logging affect the request path.
    }
  }
  return {
    debug: (m, e) => send("debug", m, e),
    info: (m, e) => send("info", m, e),
    warn: (m, e) => send("warn", m, e),
    error: (m, e) => send("error", m, e),
  }
}
