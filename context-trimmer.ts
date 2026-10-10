/**
 * context-trimmer — opencode plugin
 *
 * Trims / rewrites the messages that are about to be sent upstream, driven by a
 * set of pluggable strategies. Each strategy decides (a) whether it applies to
 * the current request and (b) how to transform the message list.
 *
 * Why two hooks:
 *   - `experimental.chat.messages.transform` is where we can actually rewrite the
 *     outgoing messages, but its `input` is empty — it cannot see the model.
 *   - `chat.params` fires earlier for the same turn and *does* carry the model,
 *     so we use it to record per-session context (model/provider) that the
 *     transform hook then reads back.
 *
 * Extending: add a file under ./context-trimmer/strategies/ and register it in
 * ./context-trimmer/strategies/index.ts. Nothing here needs to change.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { SessionContextStore } from "./context-trimmer/context"
import { runStrategies } from "./context-trimmer/pipeline"
import { strategies } from "./context-trimmer/strategies"
import type { ChatMessage } from "./context-trimmer/strategies/types"
import { createRecallTool } from "./context-trimmer/tools/recall"
import { loadConfig } from "./context-trimmer/config"
import { createLogger } from "./context-trimmer/logger"

/**
 * Plugin version, surfaced in the `plugin loaded` log line so a restart makes it
 * obvious WHICH build is actually running (e.g. after an npm bump or a manual
 * copy into ~/.config/opencode/plugin). Keep in sync with package.json "version";
 * we hardcode it rather than import package.json because the local-file install
 * only copies the source, not package.json.
 */
const VERSION = "0.2.1"

export const ContextTrimmer: Plugin = async ({ client }) => {
  const store = new SessionContextStore()
  const log = createLogger(client)

  // One line at load so you can confirm the plugin is active, see its version
  // and config:  grep context-trimmer ~/.local/share/opencode/log/opencode.log
  const cfg = loadConfig()
  log.info("plugin loaded", {
    version: VERSION,
    enabled: cfg.enabled,
    threshold: cfg.threshold,
    recentFullTurns: cfg.recentFullTurns,
    priorTrimmedTurns: cfg.priorTrimmedTurns,
    cacheAwareMinutes: cfg.cacheAwareMinutes,
    hardTriggerTurns: cfg.hardTriggerTurns,
    breadcrumbUserMessages: cfg.breadcrumbUserMessages,
    breadcrumbMaxTokens: cfg.breadcrumbMaxTokens,
  })

  return {
    // Custom tool so the model can pull back history we trimmed. opencode keeps
    // the full conversation on disk; this reads it via the client API.
    tool: {
      context_recall: createRecallTool(client),
    },

    // Capture model/provider for the current turn so the transform hook (whose
    // input is empty) can make model-aware decisions.
    "chat.params": async (input) => {
      store.set(input.sessionID, {
        sessionID: input.sessionID,
        agent: input.agent,
        providerID: input.provider?.info?.id,
        modelID: input.model?.id,
        model: input.model,
      })
    },

    // The actual rewrite point: whatever we leave in `output.messages` is what
    // gets converted to provider messages and sent upstream.
    "experimental.chat.messages.transform": async (_input, output) => {
      // Master switch: when the user disables trimming, leave the request as-is.
      if (!loadConfig().enabled) return

      const original = (output?.messages ?? []) as ChatMessage[]

      // Resolve the context by the TRUE session id carried on the messages, not
      // by store.latest(). The transform hook's input is empty, so chat.params
      // bridges model/provider info via `store`; but `store.latest()` tracks only
      // the globally most-recent chat.params. A subagent (or any interleaved
      // session) runs its own turns in the SAME process, moving that global
      // pointer onto the CHILD session. When the parent resumes, latest() would
      // hand us the child's context while `original` is the parent's messages —
      // the per-session sticky boundary is then looked up under the wrong key, so
      // trimming silently no-ops and the full (untrimmed) history overflows the
      // model context window.
      //
      // Every message carries info.sessionID, so use it as the source of truth
      // and only consult `store` to enrich that id with model/provider info.
      const sid = original.find((m) => m?.info?.sessionID)?.info?.sessionID
      let ctx = store.resolve(sid)
      if (!ctx) return

      const beforeLen = original.length
      const after = runStrategies(original.slice(), ctx, strategies)

      // CRITICAL: opencode reads the SAME array it passed in — it ignores both the
      // hook return value and any reassignment of `output.messages` (see
      // session/prompt.ts, which keeps using its local `msgs` variable after the
      // hook). So we must mutate that array IN PLACE, not point `output.messages`
      // at a new one. splice() swaps the contents while preserving the reference.
      ;(output.messages as ChatMessage[]).splice(0, beforeLen, ...after)

      const afterLen = output.messages.length
      if (afterLen !== beforeLen) {
        log.info("trimmed", {
          sessionID: ctx.sessionID,
          modelID: ctx.modelID,
          before: beforeLen,
          after: afterLen,
        })
      } else {
        log.debug("no-op (below threshold or cache hot)", { sessionID: ctx.sessionID, messages: beforeLen })
      }
    },
  }
}
