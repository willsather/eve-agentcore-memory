import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { agentCoreMemory } from "eve-agentcore-memory";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

export default defineMemory({
  description: "Recall, remember, search, and forget durable context for the authenticated caller.",
  scope: byPrincipal,
  provider: agentCoreMemory({
    memoryId: () => requiredEnv("AWS_MEMORY_ID"),
    snapshotBucket: () => requiredEnv("AWS_SNAPSHOT_BUCKET"),
    clientConfig: { region: process.env.AWS_REGION },
    snapshotClientConfig: { region: process.env.AWS_REGION },
    capture: false,
  }),
});
