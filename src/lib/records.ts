import type { MemoryToolsContext } from "eve/memory";
import { z } from "zod";
import type { Config } from "../options.js";
import { actorId, digest, namespace } from "./scope.js";

export const recordIdSchema = z.string().min(40).max(50).regex(/^mem-[a-zA-Z0-9_-]+$/);

export function rememberToken(context: MemoryToolsContext, scopeKey: string, memoryId: string, callId: string): string {
  const sessionId = context.session?.id;
  const turnId = context.turn?.id;
  if (![sessionId, turnId, callId].every((value) => typeof value === "string" && value.trim())) {
    throw new Error("Remember requires stable Eve session, turn and tool call identities.");
  }
  return digest("remember-v1", scopeKey, memoryId, sessionId!, turnId!, callId);
}

export function recordNamespaces(config: Config, scopeKey: string) {
  const actor = actorId(scopeKey);
  return {
    manual: namespace(config.manualNamespace, actor),
    facts: namespace(config.factNamespace, actor),
    preferences: namespace(config.preferenceNamespace, actor),
  };
}
