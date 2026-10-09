import assert from "node:assert/strict";
import { test } from "node:test";
import { ListMemoryRecordsCommand, RetrieveMemoryRecordsCommand, type MemoryRecordSummary } from "@aws-sdk/client-bedrock-agentcore";
import type { MemoryCompactionCompletedContext, MemoryToolsContext, MemoryTurnStartedContext } from "eve/memory";
import { agentCoreMemory } from "../src/index.js";
import { resolveOptions } from "../src/options.js";
import { actorId } from "../src/lib/scope.js";
import { boundRecords, readRecords, search } from "../src/lib/recall.js";
import { createSnapshots } from "../src/lib/snapshots.js";
import { context, mockClient, snapshotStore } from "./helpers.js";

function record(prefix: string, id = "fact-1", text = "Prefers TypeScript"): MemoryRecordSummary {
  return { memoryRecordId: id, memoryStrategyId: "strategy-1", createdAt: new Date(), content: { text }, namespaces: [prefix] };
}

function store() {
  const snapshots = snapshotStore();
  let facts = "Prefers TypeScript";
  const commands: unknown[] = [];
  const client = mockClient(async (command) => {
    commands.push(command);
    if (command instanceof ListMemoryRecordsCommand) return { memoryRecordSummaries: [record(command.input.namespace!, "pref-1", facts)] };
    if (command instanceof RetrieveMemoryRecordsCommand) return { memoryRecordSummaries: [record(command.input.namespace!, "fact-1", facts)] };
    throw new Error("Unexpected command");
  });
  return { client, commands, snapshots, options: { memoryId: "test", client, snapshotBucket: "test-snapshots", snapshotClient: snapshots.client }, change: () => { facts = "Prefers Python now"; } };
}

test("recall is bounded, scoped and durably stable after restart", async () => {
  const aws = store();
  const options = { ...aws.options, maxRecallBytes: 256 };
  const ctx = context() as MemoryTurnStartedContext;
  const first = await agentCoreMemory(options).recall["turn.started"](ctx);
  aws.change();
  assert.deepEqual(await agentCoreMemory(options).recall["turn.started"](ctx), first);
  assert.ok(first?.messages[0]?.content.includes("TypeScript"));
  assert.ok(Buffer.byteLength(first!.messages[0]!.content) <= 256);
  for (const command of aws.commands) {
    if (command instanceof ListMemoryRecordsCommand || command instanceof RetrieveMemoryRecordsCommand) {
      assert.ok(command.input.namespace?.includes(`/${actorId("scope-1")}/`));
      assert.ok(command.input.namespace?.endsWith("/"));
    }
  }
  const next = await agentCoreMemory(options).recall["turn.started"]({ ...ctx, operationId: "new-operation" });
  assert.ok(next?.messages[0]?.content.includes("Python"));
  assert.equal(next?.messages[0]?.id, first?.messages[0]?.id);
});

test("standalone compaction recalls preferences without an invented semantic query", async () => {
  const aws = store();
  const ctx = { ...context(), turn: null, compaction: { modelId: "test" } } as MemoryCompactionCompletedContext;
  const result = await agentCoreMemory(aws.options).recall["compaction.completed"]!(ctx);
  assert.ok(result?.messages[0]?.content.includes("TypeScript"));
  assert.equal(aws.commands.filter((command) => command instanceof RetrieveMemoryRecordsCommand).length, 0);
});

test("empty recall supersedes earlier context using a stable nonempty message", async () => {
  const aws = store();
  const result = await agentCoreMemory({ ...aws.options, client: mockClient(async () => ({ memoryRecordSummaries: [] })) }).recall["turn.started"](context());
  assert.equal(result?.messages[0]?.id, "agentcore-context-v1");
  assert.match(result!.messages[0]!.content, /No relevant/);
});

test("retrieval follows pagination, deduplicates and rejects foreign results", async () => {
  let calls = 0;
  const prefix = "/eve/actors/alice/";
  const client = mockClient(async (command) => {
    assert.ok(command instanceof RetrieveMemoryRecordsCommand);
    assert.equal(command.input.namespace, prefix);
    calls++;
    return calls === 1 ? { memoryRecordSummaries: [record("/eve/actors/alice2/", "foreign"), record(prefix, "one")], nextToken: "page2" }
      : { memoryRecordSummaries: [record(prefix, "one"), record(prefix, "two")] };
  });
  const result = await readRecords({ client, memoryId: "test" }, prefix, 2, new AbortController().signal, "preferences");
  assert.deepEqual(result.map((value) => value.id), ["one", "two"]);
  assert.equal(calls, 2);
});

test("repeated pagination tokens fail rather than loop", async () => {
  const client = mockClient(async () => ({ memoryRecordSummaries: [], nextToken: "same" }));
  await assert.rejects(readRecords({ client, memoryId: "test" }, "/alice/", 2, new AbortController().signal), /repeated/);
});

test("concurrent snapshot writes both return the stored winner", async () => {
  const aws = store();
  const recall = createSnapshots({ bucket: "test", client: aws.snapshots.client });
  const connection = { client: aws.client, memoryId: "test" };
  const config = resolveOptions(aws.options);
  const [a, b] = await Promise.all([
    recall(connection, context(), config, async () => ({ messages: [{ id: "context", content: "first" }] })),
    recall(connection, context(), config, async () => ({ messages: [{ id: "context", content: "second" }] })),
  ]);
  assert.deepEqual(a, b);
  assert.equal(aws.snapshots.objects.size, 1);
});

test("scope and memory resource changes cannot reuse another partition's snapshot", async () => {
  const aws = store();
  const provider = agentCoreMemory(aws.options);
  await provider.recall["turn.started"](context());
  aws.change();
  const ctx = context();
  const other = await provider.recall["turn.started"]({ ...ctx, memory: { ...ctx.memory, scope: { ...ctx.memory.scope, key: "scope-2" } } });
  assert.ok(other?.messages[0]?.content.includes("Python"));
  await agentCoreMemory({ ...aws.options, memoryId: "different-resource" }).recall["turn.started"](ctx);
  assert.equal(aws.snapshots.objects.size, 3);
});

test("recall failures and aborted operations never return provisional context", async () => {
  const aws = store();
  const provider = agentCoreMemory({ ...aws.options, client: mockClient(async () => { throw new Error("AccessDenied"); }) });
  await assert.rejects(async () => provider.recall["turn.started"](context()), /AccessDenied/);
  await assert.rejects(async () => provider.recall["turn.started"](context({ abortSignal: AbortSignal.abort() })), { name: "AbortError" });
  assert.equal(aws.snapshots.objects.size, 0);
});

test("record budgets are byte-based and bound huge IDs and text", () => {
  const result = boundRecords([{ id: "x".repeat(1000), text: "😀".repeat(1000) }], 300);
  assert.ok(Buffer.byteLength(result[0]!.text) + Buffer.byteLength(result[0]!.id) + 8 <= 300);
});

test("JSON search output respects the actual serialized byte budget", async () => {
  const aws = store();
  const config = resolveOptions({ ...aws.options, maxRecallBytes: 256, topK: 20 });
  const client = mockClient(async (command) => ({ memoryRecordSummaries: Array.from({ length: 20 }, (_, i) => record((command as RetrieveMemoryRecordsCommand).input.namespace!, String(i), '"\\\n😀'.repeat(20))) }));
  const memories = await search({ client, memoryId: "test" }, config, "scope-1", "facts", new AbortController().signal);
  assert.ok(Buffer.byteLength(JSON.stringify({ memories })) <= 256);
});

test("replaying under a smaller byte budget fails instead of changing history", async () => {
  const aws = store();
  const ctx = context();
  const recall = createSnapshots({ bucket: "test", client: aws.snapshots.client });
  const connection = { client: aws.client, memoryId: "test" };
  await recall(connection, ctx, resolveOptions(aws.options), async () => ({ messages: [{ id: "context", content: "x".repeat(2_000) }] }));
  await assert.rejects(recall(connection, ctx, resolveOptions({ ...aws.options, maxRecallBytes: 256 }), async () => { throw new Error("must not reload"); }), /Stored recall exceeds/);
});

test("corrupt snapshots fail closed without searching again", async () => {
  const aws = store();
  const provider = agentCoreMemory(aws.options);
  await provider.recall["turn.started"](context());
  const key = [...aws.snapshots.objects.keys()][0]!;
  aws.snapshots.objects.set(key, '{"invalid":true}');
  const calls = aws.commands.length;
  await assert.rejects(async () => provider.recall["turn.started"](context()));
  assert.equal(aws.commands.length, calls);
});

test("provider construction and tool resolution are lazy and capture can be disabled", async () => {
  const provider = agentCoreMemory({ memoryId() { throw new Error("runtime only"); }, capture: false });
  assert.equal(provider.capture, undefined);
  assert.deepEqual(Object.keys((await provider.tools!({ memory: context().memory } as MemoryToolsContext))!), ["search", "remember", "forget"]);
});

test("search tool closes over scope and propagates its execution abort signal", async () => {
  const aws = store();
  const tools = await agentCoreMemory(aws.options).tools!({ memory: context().memory } as MemoryToolsContext);
  const tool = tools!.search!;
  const result = await tool.execute({ query: "typescript" } as never, { abortSignal: new AbortController().signal } as never) as { memories: unknown[] };
  assert.equal(result.memories.length, 1);
  await assert.rejects(Promise.resolve(tool.execute({ query: "test" } as never, { abortSignal: AbortSignal.abort() } as never)), { name: "AbortError" });
});

test("lazy memory resolver and missing snapshot configuration fail clearly", async () => {
  await assert.rejects(resolveOptions({ memoryId: () => "" }).connection(), /empty/);
  await assert.rejects(async () => agentCoreMemory({ memoryId: "test", client: store().client }).recall["turn.started"](context()), /snapshotBucket/);
});
