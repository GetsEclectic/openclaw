import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { estimateMessagesTokens } from "../../compaction.js";
import { pruneContextMessages } from "./pruner.js";
import { getContextPruningRuntime } from "./runtime.js";

const log = createSubsystemLogger("context-pruning");
const warningEmitted = new WeakMap<object, Set<string>>();

export default function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextPruningRuntime(ctx.sessionManager);
    if (!runtime) {
      return undefined;
    }

    if (runtime.settings.mode === "cache-ttl") {
      const ttlMs = runtime.settings.ttlMs;
      const lastTouch = runtime.lastCacheTouchAt ?? null;
      if (!lastTouch || ttlMs <= 0) {
        return undefined;
      }
      if (ttlMs > 0 && Date.now() - lastTouch < ttlMs) {
        return undefined;
      }
    }

    const estTokens = estimateMessagesTokens(event.messages);
    log.debug(`context: messages=${event.messages.length} estTokens=${estTokens}`);

    const contextWindow = runtime.contextWindowTokens ?? 0;
    if (contextWindow > 0) {
      const utilization = estTokens / contextWindow;
      const emitted = warningEmitted.get(ctx.sessionManager) ?? new Set();
      if (utilization >= 0.85 && !emitted.has("critical")) {
        log.warn(`context utilization ${(utilization * 100).toFixed(0)}% — compaction imminent`);
        emitted.add("critical");
        warningEmitted.set(ctx.sessionManager, emitted);
      } else if (utilization >= 0.7 && !emitted.has("warning")) {
        log.info(`context utilization ${(utilization * 100).toFixed(0)}%`);
        emitted.add("warning");
        warningEmitted.set(ctx.sessionManager, emitted);
      }
    }

    const next = pruneContextMessages({
      messages: event.messages,
      settings: runtime.settings,
      ctx,
      isToolPrunable: runtime.isToolPrunable,
      contextWindowTokensOverride: runtime.contextWindowTokens ?? undefined,
    });

    if (next === event.messages) {
      return undefined;
    }

    if (runtime.settings.mode === "cache-ttl") {
      runtime.lastCacheTouchAt = Date.now();
    }

    return { messages: next };
  });
}
