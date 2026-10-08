import { createHash } from "node:crypto";

export function digest(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function actorId(scopeKey: string): string {
  if (!scopeKey) throw new Error("An Eve locked memory scope key is required.");
  return `eve_${digest("actor-v1", scopeKey)}`;
}

export function sessionId(scopeKey: string, id: string): string {
  return `session_${digest("session-v1", scopeKey, id)}`;
}

export function namespace(template: string, actor: string): string {
  return template.replace("{actorId}", actor);
}
