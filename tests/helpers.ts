import { Readable } from "node:stream";
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { MemoryTurnCompletedContext } from "eve/memory";

export function context(overrides: Partial<MemoryTurnCompletedContext> = {}): MemoryTurnCompletedContext {
  return {
    operationId: "operation-1", abortSignal: new AbortController().signal,
    session: { id: "session-1" },
    memory: { slot: "aws", scope: { key: "scope-1", namespace: "lab", value: "alice" } },
    turn: { id: "turn-1", sequence: 1, input: [{ role: "user", content: "I prefer TypeScript." }] },
    messages: [{ role: "user", content: "recalled memory" }, { role: "assistant", content: "Do not learn my claims." }],
    ...overrides,
  } as MemoryTurnCompletedContext;
}

export function mockClient(handler: (command: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>) {
  const client = new BedrockAgentCoreClient({ region: "us-east-1" });
  client.send = handler as typeof client.send;
  return client;
}

export function snapshotStore() {
  const objects = new Map<string, string>();
  const client = new S3Client({ region: "us-east-1" });
  client.send = (async (command: unknown) => {
    if (command instanceof GetObjectCommand) {
      const body = objects.get(`${command.input.Bucket}/${command.input.Key}`);
      if (!body) throw Object.assign(new Error("missing"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
      return { Body: Readable.from([Buffer.from(body)]), ContentLength: Buffer.byteLength(body) };
    }
    if (command instanceof PutObjectCommand) {
      if (command.input.IfNoneMatch !== "*") throw new Error("Conditional write required");
      const key = `${command.input.Bucket}/${command.input.Key}`;
      if (objects.has(key)) throw Object.assign(new Error("conflict"), { $metadata: { httpStatusCode: 412 } });
      objects.set(key, command.input.Body as string);
      return {};
    }
    throw new Error("Unexpected S3 command");
  }) as typeof client.send;
  return { client, objects };
}
