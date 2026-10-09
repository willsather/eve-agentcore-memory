import { CreateEventCommand } from "@aws-sdk/client-bedrock-agentcore";
import type { MemoryTurnCompletedContext } from "eve/memory";
import type { Config } from "../options.js";
import { actorId, digest, sessionId } from "./scope.js";
import { isUserDelivery, splitUtf8, textContent } from "./text.js";

export async function capture(context: MemoryTurnCompletedContext, config: Config): Promise<void> {
  context.abortSignal.throwIfAborted();
  const lastUser = context.messages.findLastIndex(isUserDelivery);
  const currentMessages = context.messages.slice(lastUser + 1);
  const mutations = new Set([`${context.memory.slot}__remember`, `${context.memory.slot}__forget`]);
  const handledByTool = currentMessages.some((message) => typeof message.content !== "string" &&
    message.content.some((part) => (part.type === "tool-call" || part.type === "tool-result") && mutations.has(part.toolName)));
  if (handledByTool) return;
  const texts = context.turn.input.filter(isUserDelivery).map(textContent).filter(Boolean);
  const total = texts.reduce((bytes, text) => bytes + Buffer.byteLength(text), 0);
  if (total > config.maxCaptureBytes) {
    throw new Error(`New user text exceeds the ${config.maxCaptureBytes}-byte capture budget.`);
  }
  const chunks = texts.flatMap((text) => splitUtf8(text, 90_000));
  if (!chunks.length) return;
  const { client, memoryId } = await config.connection();
  const scopeKey = context.memory.scope.key;
  for (let index = 0; index < chunks.length; index += 100) {
    context.abortSignal.throwIfAborted();
    await client.send(new CreateEventCommand({
      memoryId,
      actorId: actorId(scopeKey),
      sessionId: sessionId(scopeKey, context.session.id),
      clientToken: digest("capture-v1", scopeKey, context.operationId, String(index)),
      eventTimestamp: new Date(),
      payload: chunks.slice(index, index + 100).map((text) => ({ conversational: { role: "USER", content: { text } } })),
    }), { abortSignal: context.abortSignal });
  }
}
