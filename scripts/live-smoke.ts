import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { BedrockAgentCoreClient, ListEventsCommand } from "@aws-sdk/client-bedrock-agentcore";
import { BedrockAgentCoreControlClient, GetMemoryCommand } from "@aws-sdk/client-bedrock-agentcore-control";
import type { MemoryTurnStartedContext } from "eve/memory";
import { agentCoreMemory } from "../src/index.js";
import { actorId, sessionId } from "../src/lib/scope.js";

if (process.argv.includes("--help")) {
  console.log("AWS_REGION=<region> AWS_MEMORY_ID=<id> AWS_SNAPSHOT_BUCKET=<bucket> pnpm live-smoke --confirm\nWrites synthetic conversations and durable S3 snapshots. Tests real provider hooks, not the full Eve runtime or a model. No automatic cleanup.");
} else {
  if (!process.argv.includes("--confirm")) throw new Error("Live testing writes AWS data and requires --confirm. Run with --help first.");
  const region = process.env.AWS_REGION;
  const memoryId = process.env.AWS_MEMORY_ID;
  const snapshotBucket = process.env.AWS_SNAPSHOT_BUCKET;
  if (!region || !memoryId || !snapshotBucket) throw new Error("Set AWS_REGION, AWS_MEMORY_ID and AWS_SNAPSHOT_BUCKET after logging into the testing account.");
  const client = new BedrockAgentCoreClient({ region });
  const control = new BedrockAgentCoreControlClient({ region });
  const signal = AbortSignal.timeout(420_000);
  const memory = (await control.send(new GetMemoryCommand({ memoryId }), { abortSignal: signal })).memory;
  assert.equal(memory?.status, "ACTIVE", "Memory must be ACTIVE before capturing events");
  for (const [type, path] of [["SEMANTIC", "/eve/actors/{actorId}/facts/"], ["USER_PREFERENCE", "/eve/actors/{actorId}/preferences/"]]) {
    assert.ok(memory?.strategies?.some((strategy) => strategy.type === type && strategy.status === "ACTIVE" && (strategy.namespaceTemplates ?? strategy.namespaces)?.includes(path!)), `An ACTIVE ${type} strategy with the adapter namespace is required`);
  }
  const options = { memoryId, snapshotBucket, client, snapshotClientConfig: { region } };
  const provider = agentCoreMemory(options);
  const scope = `smoke-${randomUUID()}`;
  const firstSession = randomUUID();
  const secondSession = randomUUID();
  console.log(`Synthetic actor for this run: ${actorId(scope)}`);
  function context(session: string, key: string, input: string, operationId = randomUUID()): MemoryTurnStartedContext {
    return {
      operationId, abortSignal: signal, session: { id: session },
      memory: { slot: "aws", scope: { key, namespace: "live-smoke", value: key } },
      turn: { id: randomUUID(), sequence: 1, input: [{ role: "user", content: input }] }, messages: [],
    } as unknown as MemoryTurnStartedContext;
  }
  const question = "What programming language do I prefer for deployment examples?";
  const baselineContext = context(firstSession, scope, question);
  const baseline = await provider.recall["turn.started"](baselineContext);
  const captured = context(firstSession, scope, "For all future deployment examples, I strongly prefer TypeScript over Python. Please always use TypeScript for my code examples.");
  await provider.capture!["turn.completed"]!(captured);
  await provider.capture!["turn.completed"]!(captured);
  const events = await client.send(new ListEventsCommand({ memoryId, actorId: actorId(scope), sessionId: sessionId(scope, firstSession), includePayloads: true }), { abortSignal: signal });
  assert.equal(events.events?.length, 1, "Replayed capture should create exactly one event");
  assert.ok(!events.nextToken);
  console.log("PASS duplicate capture token");
  console.log("Waiting up to five minutes for asynchronous preference extraction...");
  const deadline = Date.now() + 300_000;
  let recalled = false;
  while (Date.now() < deadline) {
    const result = await provider.recall["turn.started"](context(secondSession, scope, question));
    if (result?.messages.some((message) => /typescript/i.test(message.content))) { recalled = true; break; }
    await setTimeout(5_000, undefined, { signal });
  }
  assert.ok(recalled, "Preference extraction did not become visible within the polling budget");
  console.log("PASS cross-session recall");
  const isolated = await provider.recall["turn.started"](context(secondSession, `other-${scope}`, question));
  assert.ok(!isolated?.messages.some((message) => /typescript/i.test(message.content)), "Another scope must not see the synthetic preference");
  console.log("PASS actor isolation");
  assert.deepEqual(await agentCoreMemory(options).recall["turn.started"](baselineContext), baseline);
  console.log("PASS durable recall replay after provider reconstruction");
  const concurrentContext = context(secondSession, scope, question);
  const [a, b] = await Promise.all([
    agentCoreMemory(options).recall["turn.started"](concurrentContext),
    agentCoreMemory(options).recall["turn.started"](concurrentContext),
  ]);
  assert.deepEqual(a, b);
  console.log("PASS concurrent recall snapshot");
  const toolContext = context(secondSession, scope, "Manage an explicit synthetic memory.");
  const tools = await provider.tools!(toolContext as never);
  const marker = `manual_${randomUUID().replaceAll("-", "")}`;
  const mutationContext = { callId: randomUUID(), abortSignal: signal } as never;
  const input = { content: `My synthetic project codename is ${marker}.` } as never;
  const remembered = await tools!.remember!.execute(input, mutationContext) as { id: string; remembered: boolean };
  assert.equal(remembered.remembered, true);
  assert.deepEqual(await tools!.remember!.execute(input, mutationContext), remembered, "Replayed remember should return the same record ID");
  console.log("PASS explicit remember and retry token");
  const searchDeadline = Date.now() + 30_000;
  let found = false;
  while (Date.now() < searchDeadline) {
    const result = await tools!.search!.execute({ query: marker } as never, { abortSignal: signal } as never) as { memories: { id: string }[] };
    if (result.memories.some((record) => record.id === remembered.id)) { found = true; break; }
    await setTimeout(1_000, undefined, { signal });
  }
  assert.ok(found, "Explicit record did not become searchable within the polling budget");
  console.log("PASS explicit record search");
  const manualContext = context(secondSession, scope, marker);
  const withManual = await provider.recall["turn.started"](manualContext);
  assert.ok(withManual?.messages.some((message) => message.content.includes(marker)), "Explicit records must participate in fresh recall");
  const otherTools = await provider.tools!(context(secondSession, `other-${scope}`, marker) as never);
  try {
    const foreign = await otherTools!.forget!.execute({ id: remembered.id } as never, { callId: randomUUID(), abortSignal: signal } as never) as { deleted: boolean };
    assert.equal(foreign.deleted, false, "Another scope must not delete this record");
  } catch (error) {
    if (!(error instanceof Error) || (error.name !== "AccessDeniedException" && !error.message.includes("verify memory record ownership"))) throw error;
  }
  const forgotten = await tools!.forget!.execute({ id: remembered.id } as never, { callId: randomUUID(), abortSignal: signal } as never) as { deleted: boolean };
  assert.equal(forgotten.deleted, true, "Only the owning scope may delete the synthetic record");
  const deleteDeadline = Date.now() + 30_000;
  let absent = false;
  while (Date.now() < deleteDeadline) {
    const afterForget = await provider.recall["turn.started"](context(secondSession, scope, marker));
    const searchAfterForget = await tools!.search!.execute({ query: marker } as never, { abortSignal: signal } as never) as { memories: { id: string }[] };
    if (!afterForget?.messages.some((message) => message.content.includes(marker)) &&
      !searchAfterForget.memories.some((record) => record.id === remembered.id)) { absent = true; break; }
    await setTimeout(1_000, undefined, { signal });
  }
  assert.ok(absent, "Deleted explicit record remained in fresh recall or search beyond the polling budget");
  assert.deepEqual(await agentCoreMemory(options).recall["turn.started"](manualContext), withManual, "Historical replay must remain stable after deletion");
  console.log(`PASS scope-checked forget, fresh recall, and historical replay\nSynthetic actor: ${actorId(scope)}\nOnly the explicit synthetic record was deleted. Raw events, other records and snapshots remain; see docs/setup.md for cleanup.`);
}
