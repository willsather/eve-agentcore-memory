import assert from "node:assert/strict";
import { test } from "node:test";
import { CreateEventCommand } from "@aws-sdk/client-bedrock-agentcore";
import { context, mockClient } from "./helpers.js";
import { capture } from "../src/capture.js";
import { resolveOptions } from "../src/options.js";
import { actorId, namespace, sessionId } from "../src/scope.js";
import { splitUtf8, truncateUtf8 } from "../src/text.js";

test("capture uses only new user text and repeatable tokens", async () => {
  const requests: CreateEventCommand[] = [];
  const config = resolveOptions({ memoryId: "test-memory", client: mockClient(async (command, options) => {
    assert.equal(options?.abortSignal, ctx.abortSignal);
    assert.ok(command instanceof CreateEventCommand);
    requests.push(command);
    return {};
  }) });
  const ctx = context();
  await capture(ctx, config);
  await capture(ctx, config);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.input.clientToken, requests[1]?.input.clientToken);
  assert.deepEqual(requests[0]?.input.payload, [{ conversational: { role: "USER", content: { text: "I prefer TypeScript." } } }]);
  assert.equal(requests[0]?.input.actorId, actorId("scope-1"));
  assert.equal(requests[0]?.input.sessionId, sessionId("scope-1", "session-1"));
});

test("capture preserves text parts but excludes files, tools, system and assistant messages", async () => {
  let command: CreateEventCommand | undefined;
  const ctx = context({ turn: { id: "t", sequence: 1, input: [
    { role: "system", content: "secret" },
    { role: "assistant", content: "claim" },
    { role: "user", content: [{ type: "text", text: "hello" }, { type: "image", image: "https://example.com/a.png" }, { type: "text", text: "world" }] },
  ] } });
  await capture(ctx, resolveOptions({ memoryId: "test", client: mockClient(async (value) => { command = value as CreateEventCommand; return {}; }) }));
  assert.deepEqual(command?.input.payload, [{ conversational: { role: "USER", content: { text: "hello\nworld" } } }]);
});

test("UTF-8 chunks and truncation preserve code points", () => {
  const text = "😀日本語".repeat(20_000);
  const chunks = splitUtf8(text, 90_000);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 90_000));
  assert.equal(truncateUtf8("a😀b", 4), "a");
  assert.equal(truncateUtf8("a😀b", 5), "a😀");
});

test("scope and session mapping are stable, bounded and isolated", () => {
  assert.equal(actorId("alice"), actorId("alice"));
  assert.notEqual(actorId("alice"), actorId("alice2"));
  assert.notEqual(sessionId("a", "same"), sessionId("b", "same"));
  assert.match(actorId("/: strange😀"), /^[a-zA-Z0-9_-]{1,255}$/);
  assert.match(sessionId("a", "x".repeat(1000)), /^[a-zA-Z0-9_-]{1,100}$/);
  assert.ok(namespace("/eve/{actorId}/", actorId("alice")).endsWith("/"));
});

test("namespace configuration rejects global, wildcard, other-variable and overlapping reads", () => {
  for (const factNamespace of ["/", "/global/", "/{actorId}*", "/{actorId}/{sessionId}/", "/prefix{actorId}/", "/{actorId}//"]) {
    assert.throws(() => resolveOptions({ memoryId: "test", factNamespace }));
  }
  assert.throws(() => resolveOptions({ memoryId: "test", factNamespace: "/{actorId}/", preferenceNamespace: "/{actorId}/preferences/" }));
});

test("capture enforces budget, cancellation and error propagation", async () => {
  const client = mockClient(async () => { throw new Error("AWS unavailable"); });
  await assert.rejects(capture(context(), resolveOptions({ memoryId: "test", client })), /AWS unavailable/);
  await assert.rejects(capture(context(), resolveOptions({ memoryId: "test", client, maxCaptureBytes: 1 })), /capture budget/);
  await assert.rejects(capture(context({ abortSignal: AbortSignal.abort() }), resolveOptions({ memoryId: "test", client })), { name: "AbortError" });
});

test("capture batches at 100 payloads with distinct deterministic tokens", async () => {
  const commands: CreateEventCommand[] = [];
  const ctx = context({ turn: { id: "many", sequence: 2, input: Array.from({ length: 201 }, () => ({ role: "user" as const, content: "synthetic" })) } });
  await capture(ctx, resolveOptions({ memoryId: "test", client: mockClient(async (command) => { commands.push(command as CreateEventCommand); return {}; }) }));
  assert.deepEqual(commands.map((command) => command.input.payload?.length), [100, 100, 1]);
  assert.equal(new Set(commands.map((command) => command.input.clientToken)).size, 3);
});

test("capture retry tokens suppress duplicate events in a token-aware AWS mock", async () => {
  const events = new Map<string, unknown>();
  const config = resolveOptions({ memoryId: "test", client: mockClient(async (value) => {
    const command = value as CreateEventCommand;
    const token = `${command.input.memoryId}/${command.input.clientToken}`;
    if (!events.has(token)) events.set(token, command.input);
    return {};
  }) });
  await capture(context(), config);
  await capture(context(), config);
  assert.equal(events.size, 1);
  await capture(context({ operationId: "next-operation" }), config);
  assert.equal(events.size, 2);
});

test("empty input performs no request or credential resolution", async () => {
  await capture(context({ turn: { id: "t", sequence: 1, input: [{ role: "user", content: " " }] } }), resolveOptions({ memoryId() { throw new Error("must remain lazy"); } }));
});
