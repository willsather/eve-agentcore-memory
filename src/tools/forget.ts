import { DeleteMemoryRecordCommand, GetMemoryRecordCommand } from "@aws-sdk/client-bedrock-agentcore";
import { defineTool } from "eve/tools";
import { z } from "zod";
import type { Config } from "../options.js";
import { recordIdSchema, recordNamespaces } from "../lib/records.js";

export function forgetTool(config: Config, scopeKey: string) {
  const inputSchema = z.object({ id: recordIdSchema }).strict();
  return defineTool({
    description: "Delete one long-term memory record belonging to the current caller by its ID. This is not full erasure: source events, current context and immutable historical recall snapshots remain, and retained source text can produce related records again. Missing records return deleted:false.",
    inputSchema,
    async execute(input, ctx) {
      ctx.abortSignal.throwIfAborted();
      const { id } = inputSchema.parse(input);
      const prefixes = recordNamespaces(config, scopeKey);
      const connection = await config.connection();
      ctx.abortSignal.throwIfAborted();
      const request = { memoryId: connection.memoryId, memoryRecordId: id };
      try {
        // get's namespace authorizes the scoped request; the returned namespaces must still be verified
        const response = await connection.client.send(new GetMemoryRecordCommand({ ...request, namespace: prefixes.manual }), { abortSignal: ctx.abortSignal });
        ctx.abortSignal.throwIfAborted();
        const record = response.memoryRecord;
        if (record?.memoryRecordId !== id || !record.namespaces?.length ||
          !record.namespaces.every((value) => typeof value === "string" && Object.values(prefixes).some((prefix) => value.startsWith(prefix)))) {
          throw new Error("Unable to verify memory record ownership.");
        }
        const deleted = await connection.client.send(new DeleteMemoryRecordCommand({ ...request, namespace: record.namespaces[0]! }), { abortSignal: ctx.abortSignal });
        ctx.abortSignal.throwIfAborted();
        if (deleted.memoryRecordId !== id) throw new Error("AWS returned an inconsistent memory deletion result.");
        return { id, deleted: true };
      } catch (error) {
        ctx.abortSignal.throwIfAborted();
        if ((error as Error)?.name === "ResourceNotFoundException") return { id, deleted: false, reason: "not_found" };
        throw error;
      }
    },
  });
}
