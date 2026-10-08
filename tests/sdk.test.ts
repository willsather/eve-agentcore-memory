import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { BedrockAgentCoreClient, CreateEventCommand } from "@aws-sdk/client-bedrock-agentcore";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const credentials = { accessKeyId: "synthetic-test-key", secretAccessKey: "synthetic-test-secret" };
type WireRequest = { body?: unknown; headers: Record<string, string> };
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
