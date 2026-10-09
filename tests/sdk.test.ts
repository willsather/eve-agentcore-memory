import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { BedrockAgentCoreClient, CreateEventCommand } from "@aws-sdk/client-bedrock-agentcore";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createTools } from "../src/tools/index.js";
import { resolveOptions } from "../src/options.js";
import { recordNamespaces } from "../src/lib/records.js";
import { context } from "./helpers.js";

const credentials = { accessKeyId: "synthetic-test-key", secretAccessKey: "synthetic-test-secret" };
type WireRequest = { body?: unknown; headers: Record<string, string>; method?: string; path?: string; query?: Record<string, unknown> };
function jsonBody(body: unknown) {
  return JSON.parse(typeof body === "string" ? body : Buffer.from(body as Uint8Array).toString("utf8"));
}

test("the real AWS serializer emits conversational event JSON and a client token", async () => {
  const client = new BedrockAgentCoreClient({ region: "us-east-1", credentials, requestHandler: {
    async handle(request: WireRequest) {
      const body = jsonBody(request.body);
      assert.equal(body.clientToken, "token-1");
      assert.equal(typeof body.eventTimestamp, "number");
      assert.deepEqual(body.payload, [{ conversational: { role: "USER", content: { text: "synthetic preference" } } }]);
      return { response: { statusCode: 201, headers: { "content-type": "application/json" }, body: Readable.from(['{"event":{"eventId":"event-1"}}']) } };
    },
  } });
  const result = await client.send(new CreateEventCommand({ memoryId: "TestMemory-1234567890", actorId: "actor", sessionId: "session", clientToken: "token-1", eventTimestamp: new Date(0), payload: [{ conversational: { role: "USER", content: { text: "synthetic preference" } } }] }));
  assert.equal(result.event?.eventId, "event-1");
});

test("remember and forget serialize real batch, scoped get and scoped delete requests", async () => {
  const id = `mem-${"a".repeat(36)}`;
  const operations: string[] = [];
  let prefix = "";
  const client = new BedrockAgentCoreClient({ region: "us-east-1", credentials, requestHandler: {
    async handle(request: WireRequest) {
      let response: unknown;
      let statusCode = 200;
      if (request.path?.endsWith("/batchCreate")) {
        operations.push("remember");
        const body = jsonBody(request.body);
        assert.equal(body.records.length, 1);
        assert.deepEqual(body.records[0].namespaces, [prefix]);
        assert.equal(typeof body.records[0].timestamp, "number");
        assert.deepEqual(body.records[0].content, { text: "synthetic explicit fact" });
        response = { successfulRecords: [{ memoryRecordId: id, status: "SUCCEEDED", requestIdentifier: body.clientToken }], failedRecords: [] };
        statusCode = 201;
      } else if (request.method === "GET") {
        operations.push("get");
        assert.ok(request.path?.endsWith(`/memoryRecord/${id}`));
        assert.equal(request.query?.namespace, prefix);
        response = { memoryRecord: { memoryRecordId: id, namespaces: [prefix], content: { text: "synthetic explicit fact" } } };
      } else {
        operations.push("delete");
        assert.equal(request.method, "DELETE");
        assert.ok(request.path?.endsWith(`/memoryRecords/${id}`));
        assert.equal(request.query?.namespace, prefix);
        response = { memoryRecordId: id };
      }
      return { response: { statusCode, headers: { "content-type": "application/json" }, body: Readable.from([Buffer.from(JSON.stringify(response))]) } };
    },
  } });
  const config = resolveOptions({ memoryId: "TestMemory-1234567890", client });
  prefix = recordNamespaces(config, context().memory.scope.key).manual;
  const tools = createTools(context() as never, config);
  const ctx = { callId: "sdk-call", abortSignal: new AbortController().signal } as never;
  assert.deepEqual(await tools.remember.execute({ content: "synthetic explicit fact" }, ctx), { id, remembered: true });
  assert.deepEqual(await tools.forget.execute({ id }, ctx), { id, deleted: true });
  assert.deepEqual(operations, ["remember", "get", "delete"]);
});

test("the real S3 serializer sends conditional and encryption headers without network access", async () => {
  const client = new S3Client({ region: "us-east-1", credentials, requestChecksumCalculation: "WHEN_REQUIRED", requestHandler: {
    async handle(request: WireRequest) {
      assert.equal(request.headers["if-none-match"], "*");
      assert.equal(request.headers["x-amz-server-side-encryption"], "AES256");
      assert.equal(request.headers["content-type"], "application/json");
      assert.equal(jsonBody(request.body).synthetic, true);
      return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } };
    },
  } });
  await client.send(new PutObjectCommand({ Bucket: "synthetic-snapshot-bucket", Key: "eve-memory/v1/test.json", Body: '{"synthetic":true}', ContentType: "application/json", ServerSideEncryption: "AES256", IfNoneMatch: "*" }));
});
