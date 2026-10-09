import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import type { Config } from "../options.js";
import type { Connection, RecallContext } from "./recall.js";
import { actorId, digest } from "./scope.js";

const snapshotSchema = z.object({
  schema: z.literal("eve-agentcore-recall-v1"),
  key: z.string(),
  result: z.object({ messages: z.array(z.object({
    id: z.string().min(1).refine((id) => Buffer.byteLength(id) <= 1_024),
    content: z.string().trim().min(1),
  }).strict()).max(1) }).strict(),
}).strict();

type Result = z.infer<typeof snapshotSchema>["result"];

function status(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

export function snapshotKey(memoryId: string, scopeKey: string, operationId: string): string {
  return `eve-memory/v1/${digest(memoryId)}/${actorId(scopeKey)}/${digest(operationId)}.json`;
}

export function createSnapshots(options: { bucket?: string | (() => string | Promise<string>); client?: S3Client; clientConfig?: ConstructorParameters<typeof S3Client>[0] }) {
  let client = options.client;
  return async function recallSnapshot(connection: Connection, context: RecallContext, config: Config, load: () => Promise<Result>): Promise<Result> {
    const bucket = typeof options.bucket === "function" ? await options.bucket() : options.bucket;
    if (!bucket?.trim()) throw new Error("snapshotBucket is required for durable Eve recall replay.");
    client ??= new S3Client(options.clientConfig ?? {});
    const key = snapshotKey(connection.memoryId, context.memory.scope.key, context.operationId);
    const request = { Bucket: bucket, Key: key };
    const signal = context.abortSignal;
    function validate(raw: unknown): Result {
      const snapshot = snapshotSchema.parse(raw);
      if (snapshot.key !== key) throw new Error("S3 recall snapshot scope or operation mismatch.");
      if (snapshot.result.messages.reduce((bytes, message) => bytes + Buffer.byteLength(message.content), 0) > config.maxRecallBytes) {
        throw new Error("Stored recall exceeds maxRecallBytes; refusing to change a replayed result.");
      }
      return snapshot.result;
    }
    async function read(): Promise<Result | undefined> {
      signal.throwIfAborted();
      try {
        const response = await client!.send(new GetObjectCommand(request), { abortSignal: signal });
        if (!response.Body) throw new Error("S3 recall snapshot has no body.");
        const body = response.Body as AsyncIterable<Uint8Array> & { destroy?: () => void };
        try {
          if (response.ContentLength && response.ContentLength > 250_000) throw new Error("S3 recall snapshot exceeds its storage budget.");
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of body) {
            signal.throwIfAborted();
            bytes += chunk.byteLength;
            if (bytes > 250_000) throw new Error("S3 recall snapshot exceeds its storage budget.");
            chunks.push(Buffer.from(chunk));
          }
          return validate(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } finally {
          body.destroy?.();
        }
      } catch (error) {
        if ((error as Error)?.name === "NoSuchKey") return undefined;
        throw error;
      }
    }
    const existing = await read();
    if (existing) return existing;
    const result = await load();
    const snapshot = { schema: "eve-agentcore-recall-v1", key, result };
    validate(snapshot);
    signal.throwIfAborted();
    try {
      await client.send(new PutObjectCommand({ ...request, Body: JSON.stringify(snapshot), ContentType: "application/json", ServerSideEncryption: "AES256", IfNoneMatch: "*" }), { abortSignal: signal });
    } catch (error) {
      if (status(error) !== 412) throw error;
    }
    // s3 is strongly consistent; every contender reads the conditionally stored winner
    const canonical = await read();
    if (!canonical) throw new Error("S3 recall snapshot disappeared after writing; refusing nondeterministic recall.");
    return canonical;
  };
}
