import assert from "node:assert/strict";
import { test } from "node:test";
import { BatchCreateMemoryRecordsCommand, DeleteMemoryRecordCommand, GetMemoryRecordCommand, ListMemoryRecordsCommand, RetrieveMemoryRecordsCommand } from "@aws-sdk/client-bedrock-agentcore";
import type { MemoryToolsContext } from "eve/memory";
import { createTools } from "../src/tools/index.js";
import { agentCoreMemory } from "../src/index.js";
import { resolveOptions } from "../src/options.js";
import { recordNamespaces } from "../src/lib/records.js";
import { context, mockClient, snapshotStore } from "./helpers.js";

test("all three namespace templates validate and reject pairwise overlap", () => {
  const config = resolveOptions({ memoryId: "test" });
  assert.equal(config.manualNamespace, "/eve/actors/{actorId}/manual/");
  const keys = ["factNamespace", "preferenceNamespace", "manualNamespace"] as const;
  for (const key of keys) {
    for (const invalid of ["/global/", "/{actorId}/../", "/{actorId}/*/", "/{actorId}/x", "/{actorId}/{actorId}/", "/{actorId}/{sessionId}/"]) {
      assert.throws(() => resolveOptions({ memoryId: "test", [key]: invalid }));
    }
  }
  for (const [index, key] of keys.entries()) {
    for (const other of keys.slice(index + 1)) {
      for (const nested of ["/{actorId}/", "/{actorId}/child/"]) {
        assert.throws(() => resolveOptions({ memoryId: "test", [key]: "/{actorId}/", [other]: nested }), /overlap/);
        assert.throws(() => resolveOptions({ memoryId: "test", [key]: nested, [other]: "/{actorId}/" }), /overlap/);
      }
    }
  }
  assert.doesNotThrow(() => resolveOptions({ memoryId: "test", factNamespace: "/{actorId}/fact/", preferenceNamespace: "/{actorId}/facts/", manualNamespace: "/{actorId}/manual/" }));
});

test("manual records lead ordinary and standalone compaction recall and participate in scoped search", async () => {
  const calls: unknown[] = [];
  const client = mockClient(async (command) => {
    calls.push(command);
    assert.ok(command instanceof ListMemoryRecordsCommand || command instanceof RetrieveMemoryRecordsCommand);
    const prefix = command.input.namespace!;
    return { memoryRecordSummaries: [{ memoryRecordId: prefix, namespaces: [prefix], content: { text: prefix.endsWith("manual/") ? "explicit note" : "preference" } }] };
  });
  const snapshots = snapshotStore();
  const options = { memoryId: "test", client, snapshotBucket: "test", snapshotClient: snapshots.client };
  const provider = agentCoreMemory(options);
  const result = await provider.recall["turn.started"](context());
  assert.ok(result!.messages[0]!.content.indexOf("explicit note") < result!.messages[0]!.content.indexOf("preference"));
  assert.ok(calls[0] instanceof ListMemoryRecordsCommand && calls[0].input.namespace?.endsWith("manual/"));
  const tools = await provider.tools!(context() as never);
  const found = await tools!.search!.execute({ query: "note" } as never, { abortSignal: new AbortController().signal } as never) as { memories: { text: string }[] };
  assert.ok(found.memories.some((record) => record.text === "explicit note"));
  calls.length = 0;
  await provider.recall["compaction.completed"]!({ ...context(), turn: null, operationId: "compaction", compaction: { modelId: "test" } });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((command) => command instanceof ListMemoryRecordsCommand));
  const prefixes = recordNamespaces(resolveOptions(options), "scope-1");
  assert.deepEqual(calls.map((command) => (command as ListMemoryRecordsCommand).input.namespace), [prefixes.manual, prefixes.preferences]);
});

function rejects(result: unknown, error: RegExp | { name: string } = /./) {
  return assert.rejects(Promise.resolve(result), error);
}

const id = `mem-${"a".repeat(36)}`;
const otherId = `mem-${"b".repeat(36)}`;
const signal = () => new AbortController().signal;
const execution = (callId = "call-1", abortSignal = signal()) => ({ callId, abortSignal }) as never;
const resolver = (overrides: Partial<MemoryToolsContext> = {}) => ({ ...context(), ...overrides }) as unknown as MemoryToolsContext;
const success = (command: BatchCreateMemoryRecordsCommand) => ({
  failedRecords: [], successfulRecords: [{ memoryRecordId: id, status: "SUCCEEDED", requestIdentifier: command.input.records![0]!.requestIdentifier }],
});

function harness(handler: Parameters<typeof mockClient>[0], ctx = resolver()) {
  const client = mockClient(handler);
  const config = resolveOptions({ memoryId: "resource-1", client });
  return { config, tools: createTools(ctx, config), prefixes: recordNamespaces(config, ctx.memory.scope.key) };
}

test("strict tool schemas reject empty input, unknown routing and invalid record IDs before AWS", async () => {
  let calls = 0;
  const { tools } = harness(async () => { calls++; throw new Error("must not call AWS"); });
  for (const routing of ["memoryId", "actorId", "namespace", "namespaces", "scopeKey", "sessionId", "clientToken"]) {
    await rejects(tools.search.execute({ query: "hello", [routing]: "foreign" }, execution()));
    await rejects(tools.remember.execute({ content: "hello", [routing]: "foreign" }, execution()));
    await rejects(tools.forget.execute({ id, [routing]: "foreign" }, execution()));
  }
  for (const query of ["", " \n ", "q".repeat(4_001)]) await rejects(tools.search.execute({ query }, execution()));
  for (const content of ["", " \n ", "x".repeat(16_001), "😀".repeat(4_001)]) await rejects(tools.remember.execute({ content }, execution()));
  for (const invalid of ["", "mem-short", `mem-${"a".repeat(35)}`, `mem-${"a".repeat(47)}`, `foo-${"a".repeat(36)}`, `mem-${"/".repeat(36)}`, `mem-${"!".repeat(36)}`, ` ${id}`, `${id}\n`]) {
    await rejects(tools.forget.execute({ id: invalid }, execution()));
  }
  assert.equal(calls, 0);
});

test("remember directly creates one trimmed manual record at the UTF-8 limit without a strategy", async () => {
  let input: BatchCreateMemoryRecordsCommand["input"] | undefined;
  const before = Date.now();
  const { tools, prefixes } = harness(async (command, options) => {
    assert.ok(command instanceof BatchCreateMemoryRecordsCommand);
    assert.ok(options?.abortSignal);
    input = command.input;
    return success(command);
  });
  assert.deepEqual(await tools.remember.execute({ content: `  ${"😀".repeat(4_000)} \n ` }, execution()), { id, remembered: true });
  assert.equal(input!.memoryId, "resource-1");
  assert.equal(input!.records!.length, 1);
  const record = input!.records![0]!;
  assert.deepEqual(record.namespaces, [prefixes.manual]);
  assert.deepEqual(record.content, { text: "😀".repeat(4_000) });
  assert.equal(record.memoryStrategyId, undefined);
  assert.equal(record.requestIdentifier, input!.clientToken);
  assert.match(input!.clientToken!, /^[a-f0-9]{64}$/);
  assert.ok(record.timestamp!.getTime() >= before && record.timestamp!.getTime() <= Date.now());
});

test("remember and forget accept AWS record IDs containing underscores", async () => {
  const underscoreId = `mem-${"a_".repeat(18)}`;
  const commands: unknown[] = [];
  const { tools, prefixes } = harness(async (command) => {
    commands.push(command);
    if (command instanceof BatchCreateMemoryRecordsCommand) {
      const response = success(command);
      return { ...response, successfulRecords: [{ ...response.successfulRecords[0], memoryRecordId: underscoreId }] };
    }
    if (command instanceof GetMemoryRecordCommand) {
      assert.equal(command.input.memoryRecordId, underscoreId);
      return { memoryRecord: { memoryRecordId: underscoreId, namespaces: [prefixes.manual] } };
    }
    assert.ok(command instanceof DeleteMemoryRecordCommand);
    assert.equal(command.input.memoryRecordId, underscoreId);
    return { memoryRecordId: underscoreId };
  });
  assert.deepEqual(await tools.remember.execute({ content: "note" }, execution()), { id: underscoreId, remembered: true });
  assert.deepEqual(await tools.forget.execute({ id: underscoreId }, execution()), { id: underscoreId, deleted: true });
  assert.equal(commands.length, 3);
});

test("remember accepts a single successful record without the optional request identifier", async () => {
  for (const optional of [{}, { requestIdentifier: undefined }]) {
    const { tools } = harness(async (command) => {
      assert.ok(command instanceof BatchCreateMemoryRecordsCommand);
      return { failedRecords: [], successfulRecords: [{ memoryRecordId: id, status: "SUCCEEDED", ...optional }] };
    });
    assert.deepEqual(await tools.remember.execute({ content: "note" }, execution()), { id, remembered: true });
  }
});

test("remember tokens replay identically and distinguish session, turn, scope, resource and call", async () => {
  const tokens: string[] = [];
  const client = mockClient(async (command) => {
    assert.ok(command instanceof BatchCreateMemoryRecordsCommand);
    tokens.push(command.input.clientToken!);
    return success(command);
  });
  async function run(ctx = resolver(), memoryId = "resource-1", callId = "call-1") {
    const config = resolveOptions({ memoryId, client });
    return createTools(ctx, config).remember.execute({ content: "note" }, execution(callId));
  }
  await run();
  await run();
  await run(resolver({ session: { id: "session-2" } as MemoryToolsContext["session"] }));
  await run(resolver({ turn: { ...context().turn, id: "turn-2" } }));
  await run(resolver({ memory: { ...context().memory, scope: { ...context().memory.scope, key: "scope-2" } } }));
  await run(resolver(), "resource-2");
  await run(resolver(), "resource-1", "call-2");
  assert.equal(tokens[0], tokens[1]);
  assert.equal(new Set(tokens).size, 6);
});

test("mutation identity fields are lazy at construction but remember requires stable identities", async () => {
  let sends = 0;
  const client = mockClient(async () => { sends++; throw new Error("must not write"); });
  const config = resolveOptions({ memoryId: "resource-1", client });
  const partial = { memory: context().memory } as MemoryToolsContext;
  assert.deepEqual(Object.keys(createTools(partial, config)), ["search", "remember", "forget"]);
  for (const ctx of [partial, resolver({ turn: undefined } as unknown as Partial<MemoryToolsContext>), resolver({ session: { id: "" } as MemoryToolsContext["session"] })]) {
    await rejects(createTools(ctx, config).remember.execute({ content: "note" }, execution()), /stable Eve/);
  }
  await rejects(createTools(resolver(), config).remember.execute({ content: "note" }, execution("")), /stable Eve/);
  assert.equal(sends, 0);
});

test("remember rejects partial, empty, mismatched and contradictory creation results", async () => {
  const responses = [
    {}, { successfulRecords: [], failedRecords: [] },
    { failedRecords: [{ status: "FAILED", errorCode: 500 }], successfulRecords: [{ memoryRecordId: id, status: "SUCCEEDED" }] },
  ];
  for (const response of responses) {
    const { tools } = harness(async () => response);
    await rejects(tools.remember.execute({ content: "note" }, execution()), /AWS/);
  }
  for (const patch of [
    { memoryRecordId: undefined }, { memoryRecordId: "invalid" }, { status: "FAILED" }, { status: undefined },
    { requestIdentifier: "" }, { requestIdentifier: null }, { requestIdentifier: 123 }, { requestIdentifier: "different" }, { errorCode: 500 }, { errorMessage: "contradiction" },
  ]) {
    const { tools } = harness(async (command) => {
      assert.ok(command instanceof BatchCreateMemoryRecordsCommand);
      const response = success(command);
      return { ...response, successfulRecords: [{ ...response.successfulRecords[0], ...patch }] };
    });
    await rejects(tools.remember.execute({ content: "note" }, execution()), /inconsistent/);
  }
  const { tools } = harness(async (command) => {
    assert.ok(command instanceof BatchCreateMemoryRecordsCommand);
    const response = success(command);
    return { ...response, successfulRecords: [...response.successfulRecords, ...response.successfulRecords] };
  });
  await rejects(tools.remember.execute({ content: "note" }, execution()), /inconsistent/);
});

test("all tools honor cancellation before and after lazy connection resolution", async () => {
  for (const phase of ["before", "connection"]) {
    for (const tool of ["search", "remember", "forget"] as const) {
      const controller = new AbortController();
      let sends = 0;
      let resolutions = 0;
      const config = resolveOptions({
        memoryId: async () => { resolutions++; controller.abort(); return "resource-1"; },
        client: mockClient(async () => { sends++; return {}; }),
      });
      const tools = createTools(resolver(), config);
      if (phase === "before") controller.abort();
      const ctx = execution("call-1", controller.signal);
      const result = tool === "search" ? tools.search.execute({ query: "note" }, ctx)
        : tool === "remember" ? tools.remember.execute({ content: "note" }, ctx)
        : tools.forget.execute({ id }, ctx);
      await rejects(result, { name: "AbortError" });
      assert.equal(sends, 0);
      assert.equal(resolutions, phase === "before" ? 0 : 1);
    }
  }
});

test("forget verifies all namespaces and deletes using the actual namespace, including facts and preferences", async () => {
  for (const kind of ["manual", "facts", "preferences"] as const) {
    const commands: unknown[] = [];
    const controller = new AbortController();
    const { tools, prefixes } = harness(async (command, options) => {
      commands.push(command);
      assert.equal(options?.abortSignal, controller.signal);
      if (command instanceof GetMemoryRecordCommand) {
        assert.deepEqual(command.input, { memoryId: "resource-1", memoryRecordId: id, namespace: prefixes.manual });
        return { memoryRecord: { memoryRecordId: id, namespaces: [`${prefixes[kind]}nested/`, prefixes.manual] } };
      }
      assert.ok(command instanceof DeleteMemoryRecordCommand);
      assert.deepEqual(command.input, { memoryId: "resource-1", memoryRecordId: id, namespace: `${prefixes[kind]}nested/` });
      return { memoryRecordId: id };
    });
    assert.deepEqual(await tools.forget.execute({ id }, execution("call-1", controller.signal)), { id, deleted: true });
    assert.equal(commands.length, 2);
    assert.match(tools.forget.description, /not full erasure/);
    assert.match(tools.forget.description, /historical recall snapshots remain/);
  }
});

test("forget rejects foreign, prefix-collision, mixed and unverifiable records with a generic error", async () => {
  const config = resolveOptions({ memoryId: "resource-1" });
  const prefixes = recordNamespaces(config, "scope-1");
  const foreign = recordNamespaces(config, "scope-2").manual;
  const records = [
    undefined, {}, { memoryRecordId: otherId, namespaces: [prefixes.manual] },
    { memoryRecordId: id, namespaces: undefined }, { memoryRecordId: id, namespaces: [] },
    ...[
      [foreign], ["/global/"], [prefixes.manual.slice(0, -1)], [`${prefixes.manual.slice(0, -1)}2/`],
      [prefixes.manual.replace("/manual/", "2/manual/")],
      [prefixes.manual, foreign], [prefixes.manual, "/global/"], [prefixes.manual, ""],
    ].map((namespaces) => ({ memoryRecordId: id, namespaces })),
  ];
  for (const record of records) {
    let deletes = 0;
    const { tools } = harness(async (command) => {
      if (command instanceof GetMemoryRecordCommand) return { memoryRecord: record };
      deletes++;
      return { memoryRecordId: id };
    });
    await rejects(tools.forget.execute({ id }, execution()), /^Error: Unable to verify memory record ownership\.$/);
    assert.equal(deletes, 0);
  }
});

test("forget not-found during get or delete is bounded and never claims deletion", async () => {
  for (const missingAt of ["get", "delete"]) {
    let calls = 0;
    const { tools, prefixes } = harness(async (command) => {
      calls++;
      if (command instanceof GetMemoryRecordCommand && missingAt === "delete") {
        return { memoryRecord: { memoryRecordId: id, namespaces: [prefixes.manual] } };
      }
      throw Object.assign(new Error("missing"), { name: "ResourceNotFoundException", $metadata: { httpStatusCode: 404 } });
    });
    assert.deepEqual(await tools.forget.execute({ id }, execution()), { id, deleted: false, reason: "not_found" });
    assert.equal(calls, missingAt === "get" ? 1 : 2);
  }
});

test("remember and forget propagate permissions, generic 404s and network failures", async () => {
  for (const name of ["AccessDeniedException", "NetworkError", "NotFound", "Error"]) {
    const error = Object.assign(new Error("upstream failure"), { name, $metadata: { httpStatusCode: 404 } });
    const { tools } = harness(async () => { throw error; });
    await rejects(tools.remember.execute({ content: "note" }, execution()), { name });
    await rejects(tools.forget.execute({ id }, execution()), { name });
    const { tools: deleteTools, prefixes } = harness(async (command) => {
      if (command instanceof GetMemoryRecordCommand) return { memoryRecord: { memoryRecordId: id, namespaces: [prefixes.manual] } };
      throw error;
    });
    await rejects(deleteTools.forget.execute({ id }, execution()), { name });
  }
});

test("forget validates deletion acknowledgement instead of claiming an inconsistent success", async () => {
  for (const response of [{}, { memoryRecordId: otherId }, { memoryRecordId: "invalid" }]) {
    const { tools, prefixes } = harness(async (command) => command instanceof GetMemoryRecordCommand
      ? { memoryRecord: { memoryRecordId: id, namespaces: [prefixes.manual] } } : response);
    await rejects(tools.forget.execute({ id }, execution()), /inconsistent memory deletion/);
  }
});

test("cancellation after get prevents delete and cancellation after writes prevents success claims", async () => {
  for (const cancelAt of ["get", "delete", "remember"]) {
    const controller = new AbortController();
    const calls: unknown[] = [];
    const { tools, prefixes } = harness(async (command) => {
      calls.push(command);
      if (command instanceof GetMemoryRecordCommand) {
        if (cancelAt === "get") controller.abort();
        return { memoryRecord: { memoryRecordId: id, namespaces: [prefixes.manual] } };
      }
      controller.abort();
      if (command instanceof BatchCreateMemoryRecordsCommand) return success(command);
      return { memoryRecordId: id };
    });
    const ctx = execution("call-1", controller.signal);
    await rejects(cancelAt === "remember" ? tools.remember.execute({ content: "note" }, ctx) : tools.forget.execute({ id }, ctx), { name: "AbortError" });
    assert.equal(calls.length, cancelAt === "delete" ? 2 : 1);
  }
});

test("explicit record lifecycle changes new recall and search but preserves historical snapshots", async () => {
  const records = new Map<string, { memoryRecordId: string; namespaces: string[]; content: { text: string } }>();
  const tokens = new Map<string, string>();
  let creates = 0;
  const client = mockClient(async (command) => {
    if (command instanceof BatchCreateMemoryRecordsCommand) {
      const record = command.input.records![0]!;
      if (!tokens.has(command.input.clientToken!)) {
        creates++;
        tokens.set(command.input.clientToken!, id);
        records.set(id, { memoryRecordId: id, namespaces: record.namespaces!, content: { text: record.content!.text! } });
      }
      return success(command);
    }
    if (command instanceof GetMemoryRecordCommand) {
      if (!records.has(command.input.memoryRecordId!)) throw Object.assign(new Error("missing"), { name: "ResourceNotFoundException" });
      return { memoryRecord: records.get(command.input.memoryRecordId!) };
    }
    if (command instanceof DeleteMemoryRecordCommand) {
      records.delete(command.input.memoryRecordId!);
      return { memoryRecordId: command.input.memoryRecordId };
    }
    assert.ok(command instanceof ListMemoryRecordsCommand || command instanceof RetrieveMemoryRecordsCommand);
    return { memoryRecordSummaries: [...records.values()].filter((record) => record.namespaces.some((prefix) => prefix.startsWith(command.input.namespace!))) };
  });
  const snapshots = snapshotStore();
  const options = { memoryId: "resource-1", client, capture: false, maxRecallBytes: 256, snapshotBucket: "test", snapshotClient: snapshots.client };
  const provider = agentCoreMemory(options);
  const beforeContext = context({ operationId: "before-remember" });
  const before = await provider.recall["turn.started"](beforeContext);
  assert.match(before!.messages[0]!.content, /No relevant/);
  const tools = await provider.tools!(resolver());
  const content = "explicit note " + "😀".repeat(500);
  assert.deepEqual(await tools!.remember!.execute({ content } as never, execution()), { id, remembered: true });
  const recreated = await agentCoreMemory(options).tools!(resolver());
  assert.deepEqual(await recreated!.remember!.execute({ content } as never, execution()), { id, remembered: true });
  assert.equal(creates, 1);
  const visibleContext = context({ operationId: "after-remember", turn: { ...context().turn, input: [] } });
  const visible = await provider.recall["turn.started"](visibleContext);
  assert.match(visible!.messages[0]!.content, /explicit note/);
  assert.equal(visible!.messages[0]!.id, "agentcore-context-v1");
  assert.ok(Buffer.byteLength(visible!.messages[0]!.content) <= 256);
  assert.deepEqual(await agentCoreMemory(options).recall["turn.started"](beforeContext), before);
  const found = await tools!.search!.execute({ query: "explicit" } as never, execution()) as { memories: { id: string }[] };
  assert.deepEqual(found.memories.map((record) => record.id), [id]);
  const compactionContext = { ...context(), operationId: "compaction-with-note", turn: null, compaction: { modelId: "test" } };
  const compacted = await provider.recall["compaction.completed"]!(compactionContext);
  assert.match(compacted!.messages[0]!.content, /explicit note/);
  const historical = new Map(snapshots.objects);
  assert.deepEqual(await tools!.forget!.execute({ id } as never, execution()), { id, deleted: true });
  assert.deepEqual(snapshots.objects, historical);
  assert.deepEqual(await tools!.search!.execute({ query: "explicit" } as never, execution()), { memories: [] });
  const absent = await provider.recall["turn.started"](context({ operationId: "after-forget" }));
  assert.match(absent!.messages[0]!.content, /No relevant/);
  const absentCompaction = await provider.recall["compaction.completed"]!({ ...compactionContext, operationId: "compaction-after-forget" });
  assert.match(absentCompaction!.messages[0]!.content, /No relevant/);
  assert.deepEqual(await agentCoreMemory(options).recall["turn.started"](visibleContext), visible);
  assert.deepEqual(await agentCoreMemory(options).recall["compaction.completed"]!(compactionContext), compacted);
  assert.deepEqual(await recreated!.forget!.execute({ id } as never, execution()), { id, deleted: false, reason: "not_found" });
});

test("forget deletes only the specified long-term record, not related extracted source content", async () => {
  const config = resolveOptions({ memoryId: "resource-1" });
  const prefixes = recordNamespaces(config, "scope-1");
  let explicitPresent = true;
  const deletes: string[] = [];
  const { tools } = harness(async (command) => {
    if (command instanceof GetMemoryRecordCommand) return { memoryRecord: { memoryRecordId: id, namespaces: [prefixes.manual] } };
    if (command instanceof DeleteMemoryRecordCommand) { deletes.push(command.input.memoryRecordId!); explicitPresent = false; return { memoryRecordId: id }; }
    assert.ok(command instanceof RetrieveMemoryRecordsCommand);
    const records = [
      ...(explicitPresent ? [{ memoryRecordId: id, namespaces: [prefixes.manual], content: { text: "same retained text" } }] : []),
      { memoryRecordId: otherId, namespaces: [prefixes.facts], content: { text: "same retained text" } },
    ];
    return { memoryRecordSummaries: records.filter((record) => record.namespaces.includes(command.input.namespace!)) };
  });
  await tools.forget.execute({ id }, execution());
  const found = await tools.search.execute({ query: "retained" }, execution()) as { memories: { id: string }[] };
  assert.deepEqual(deletes, [id]);
  assert.deepEqual(found.memories.map((record) => record.id), [otherId]);
});

test("search never returns a provisional result after retrieval cancellation", async () => {
  const controller = new AbortController();
  const { tools, prefixes } = harness(async () => {
    controller.abort();
    return { memoryRecordSummaries: [{ memoryRecordId: id, namespaces: [prefixes.manual], content: { text: "note" } }] };
  });
  await rejects(tools.search.execute({ query: "note" }, execution("call-1", controller.signal)), { name: "AbortError" });
});
