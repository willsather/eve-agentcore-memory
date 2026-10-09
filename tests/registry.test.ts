import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);

test("registry item embeds the reviewed source and declares the correct installation target", async () => {
  const catalog = JSON.parse(await readFile(new URL("registry.json", root), "utf8"));
  const item = JSON.parse(await readFile(new URL("registry/memory/agentcore.json", root), "utf8"));
  const source = await readFile(new URL("registry/memory/agentcore.ts", root), "utf8");
  assert.equal(catalog.items.length, 1);
  assert.equal(item.name, "memory/agentcore");
  assert.equal(item.type, "registry:item");
  assert.deepEqual(item.dependencies, ["eve-agentcore-memory"]);
  assert.deepEqual(Object.keys(item.envVars).sort(), ["AWS_MEMORY_ID", "AWS_REGION", "AWS_SNAPSHOT_BUCKET"]);
  assert.equal(item.files.length, 1);
  assert.equal(item.files[0].target, "agent/memory/agentcore.ts");
  assert.equal(item.files[0].type, "registry:file");
  assert.equal(item.files[0].content, source);
  const { content: _content, ...file } = item.files[0];
  assert.deepEqual(file, catalog.items[0].files[0]);
  assert.ok(source.includes("capture: false"));
  assert.ok(source.includes('memoryId: () => requiredEnv("AWS_MEMORY_ID")'));
  assert.ok(!source.includes("namespace:"), "Use Eve's project/deployment-aware default namespace in the generated slot");
});

test("the installed Eve registry reader accepts the item over local HTTP", async () => {
  const payload = await readFile(new URL("registry/memory/agentcore.json", root), "utf8");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(payload);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const require = createRequire(import.meta.url);
    const readerUrl = new URL("./compiled/shadcn-registry/index.js", pathToFileURL(require.resolve("eve")));
    const reader = await import(readerUrl.href) as { getRegistryItems(items: string[], options: { useCache: boolean }): Promise<unknown[]> };
    const results = await reader.getRegistryItems([`http://127.0.0.1:${address.port}/memory/agentcore.json`], { useCache: false });
    assert.equal(results.length, 1);
    const item = results[0] as { name: string; files: { content: string; target: string }[] };
    assert.equal(item.name, "memory/agentcore");
    assert.equal(item.files[0]?.target, "agent/memory/agentcore.ts");
    assert.equal(item.files[0]?.content, JSON.parse(payload).files[0].content);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
