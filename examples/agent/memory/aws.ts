import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { agentCoreMemory } from "../../../src/index.js";

export default defineMemory({
  namespace: "agentcore-demo-v1",
  description: "Recall the authenticated caller's durable preferences and facts from AWS.",
  scope: byPrincipal,
  provider: agentCoreMemory({
    memoryId: () => process.env.AWS_MEMORY_ID!,
    snapshotBucket: () => process.env.AWS_SNAPSHOT_BUCKET!,
  }),
});
