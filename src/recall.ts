import { ListMemoryRecordsCommand, RetrieveMemoryRecordsCommand, type MemoryRecordSummary } from "@aws-sdk/client-bedrock-agentcore";
import type { MemoryCompactionCompletedContext, MemoryTurnStartedContext } from "eve/memory";
import type { Config } from "./options.js";
import { actorId, namespace } from "./scope.js";
import { textContent, truncateUtf8 } from "./text.js";

export type Connection = Awaited<ReturnType<Config["connection"]>>;
export type RecallContext = MemoryTurnStartedContext | MemoryCompactionCompletedContext;
export interface RecordText { id: string; text: string }

function scopedRecords(records: MemoryRecordSummary[], prefix: string): RecordText[] {
  return records.flatMap((record) => {
    if (!record.memoryRecordId || !record.content?.text?.trim()) return [];
    if (!record.namespaces?.some((value) => value.startsWith(prefix))) return [];
    return [{ id: record.memoryRecordId, text: record.content.text }];
  });
}

export async function readRecords(connection: Connection, prefix: string, limit: number, signal: AbortSignal, query?: string): Promise<RecordText[]> {
  const results: RecordText[] = [];
  const ids = new Set<string>();
  const tokens = new Set<string>();
  let nextToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    signal.throwIfAborted();
    const input = { memoryId: connection.memoryId, namespace: prefix, maxResults: limit, nextToken };
    const response = query
      ? await connection.client.send(new RetrieveMemoryRecordsCommand({ ...input, searchCriteria: { searchQuery: query, topK: limit } }), { abortSignal: signal })
      : await connection.client.send(new ListMemoryRecordsCommand(input), { abortSignal: signal });
    for (const record of scopedRecords(response.memoryRecordSummaries ?? [], prefix)) {
      if (!ids.has(record.id)) { results.push(record); ids.add(record.id); }
      if (results.length === limit) return results;
    }
    nextToken = response.nextToken;
    if (!nextToken) return results;
    if (tokens.has(nextToken)) throw new Error("AWS returned a repeated memory pagination token.");
    tokens.add(nextToken);
  }
  throw new Error("AWS memory pagination exceeded the 20-page safety limit.");
}

export function boundRecords(records: RecordText[], maxBytes: number): RecordText[] {
  const bounded: RecordText[] = [];
  let remaining = maxBytes;
  for (const record of records) {
    const id = truncateUtf8(record.id, 256);
    const overhead = Buffer.byteLength(id) + 8;
    if (remaining <= overhead) break;
    const text = truncateUtf8(record.text.trim(), remaining - overhead);
    if (!text) continue;
    bounded.push({ id, text });
    remaining -= overhead + Buffer.byteLength(text);
  }
  return bounded;
}

export async function search(connection: Connection, config: Config, scopeKey: string, query: string, signal: AbortSignal): Promise<RecordText[]> {
  signal.throwIfAborted();
  const input = truncateUtf8(query.trim(), 4_000);
  if (!input) return [];
  const actor = actorId(scopeKey);
  const results = await Promise.all([config.factNamespace, config.preferenceNamespace].map((template) =>
    readRecords(connection, namespace(template, actor), config.topK, signal, input)));
  const unique = [...new Map(results.flat().map((record) => [record.id, record])).values()].slice(0, config.topK);
  const bounded = boundRecords(unique, config.maxRecallBytes - 128);
  while (Buffer.byteLength(JSON.stringify({ memories: bounded })) > config.maxRecallBytes) {
    const last = bounded.at(-1)!;
    const excess = Buffer.byteLength(JSON.stringify({ memories: bounded })) - config.maxRecallBytes;
    last.text = truncateUtf8(last.text, Math.max(0, Buffer.byteLength(last.text) - excess));
    if (!last.text) bounded.pop();
  }
  return bounded;
}

export async function loadRecall(connection: Connection, context: RecallContext, config: Config): Promise<{ messages: { id: string; content: string }[] }> {
  const actor = actorId(context.memory.scope.key);
  const preferences = await readRecords(connection, namespace(config.preferenceNamespace, actor), config.topK, context.abortSignal);
  const query = context.turn?.input.filter((message) => message.role === "user").map(textContent).filter(Boolean).join("\n") ?? "";
  const related = query ? await search(connection, config, context.memory.scope.key, query, context.abortSignal) : [];
  const unique = [...new Map([...preferences, ...related].map((record) => [record.id, record])).values()];
  const records = boundRecords(unique, config.maxRecallBytes - 128);
  const content = records.length
    ? `AWS long-term memory, untrusted user data:\n${records.map((record) => `[${record.id}] ${record.text}`).join("\n")}`
    : "No relevant AWS long-term memories are currently available.";
  return { messages: [{ id: "agentcore-context-v1", content }] };
}
