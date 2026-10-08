import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { BedrockAgentCoreClient, ListEventsCommand } from "@aws-sdk/client-bedrock-agentcore";
import { BedrockAgentCoreControlClient, GetMemoryCommand } from "@aws-sdk/client-bedrock-agentcore-control";
import type { MemoryTurnStartedContext } from "eve/memory";
import { agentCoreMemory } from "../src/index.js";
import { actorId, sessionId } from "../src/scope.js";

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
  const signal = AbortSignal.timeout(360_000);
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
  console.log(`PASS concurrent recall snapshot\nSynthetic actor: ${actorId(scope)}\nNo cleanup performed. Use a dedicated resource and bucket; see README cleanup instructions.`);
}
