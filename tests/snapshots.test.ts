import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { resolveOptions } from "../src/options.js";
import { createSnapshots } from "../src/snapshots.js";
import { context, mockClient, snapshotStore } from "./helpers.js";

const result = { messages: [{ id: "context", content: "a synthetic preference" }] };

function setup() {
  const store = snapshotStore();
  const connection = { memoryId: "test", client: mockClient(async () => { throw new Error("no retrieval expected"); }) };
  const config = resolveOptions({ memoryId: "test" });
  const recall = createSnapshots({ bucket: "test", client: store.client });
  return { store, connection, config, recall };
}

test("S3 access errors are not treated as missing snapshots", async () => {
  const { store, connection, config, recall } = setup();
  store.client.send = (async () => { throw Object.assign(new Error("AccessDenied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }); }) as typeof store.client.send;
  await assert.rejects(recall(connection, context(), config, async () => { throw new Error("must not load"); }), /AccessDenied/);
});

test("an interrupted write replays its saved result rather than re-querying", async () => {
  const { store, connection, config, recall } = setup();
  const send = store.client.send.bind(store.client);
  let interrupted = false;
  store.client.send = (async (command: unknown) => {
    const response = await send(command as never);
    if (command instanceof PutObjectCommand && !interrupted) { interrupted = true; throw new Error("lost write response"); }
    return response;
  }) as typeof store.client.send;
  await assert.rejects(recall(connection, context(), config, async () => result), /lost write response/);
  assert.deepEqual(await recall(connection, context(), config, async () => { throw new Error("must not query again"); }), result);
});

test("non-precondition write errors fail closed", async () => {
  const { store, connection, config, recall } = setup();
  const send = store.client.send.bind(store.client);
  store.client.send = (async (command: unknown) => {
    if (command instanceof PutObjectCommand) throw Object.assign(new Error("write conflict"), { $metadata: { httpStatusCode: 409 } });
    return send(command as never);
  }) as typeof store.client.send;
  await assert.rejects(recall(connection, context(), config, async () => result), /write conflict/);
});

test("snapshots deleted after a conditional write fail rather than return speculative data", async () => {
  const { store, connection, config, recall } = setup();
  const send = store.client.send.bind(store.client);
  store.client.send = (async (command: unknown) => {
    const response = await send(command as never);
    if (command instanceof PutObjectCommand) store.objects.clear();
    return response;
  }) as typeof store.client.send;
  await assert.rejects(recall(connection, context(), config, async () => result), /disappeared/);
});

test("snapshot schema enforces Eve IDs and scope binding", async () => {
  const { store, connection, config, recall } = setup();
  await assert.rejects(recall(connection, context(), config, async () => ({ messages: [{ id: "😀".repeat(300), content: "hello" }] })));
  await recall(connection, context(), config, async () => result);
  const key = [...store.objects.keys()][0]!;
  const saved = JSON.parse(store.objects.get(key)!);
  saved.key = "another scope";
  store.objects.set(key, JSON.stringify(saved));
  await assert.rejects(recall(connection, context(), config, async () => result), /mismatch/);
});

test("oversized content-length rejection releases the response stream", async () => {
  const { store, connection, config, recall } = setup();
  const body = Readable.from([Buffer.from("unread")]);
  store.client.send = (async () => ({ Body: body, ContentLength: 250_001 })) as typeof store.client.send;
  await assert.rejects(recall(connection, context(), config, async () => result), /storage budget/);
  assert.equal(body.destroyed, true);
});

test("snapshot streams exceeding the hard storage budget are rejected", async () => {
  const { store, connection, config, recall } = setup();
  store.client.send = (async (command: unknown) => {
    assert.ok(command instanceof GetObjectCommand);
    return { Body: Readable.from([Buffer.alloc(250_001)]) };
  }) as typeof store.client.send;
  await assert.rejects(recall(connection, context(), config, async () => result), /storage budget/);
});
