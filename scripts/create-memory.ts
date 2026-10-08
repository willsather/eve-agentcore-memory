import { setTimeout } from "node:timers/promises";
import { BedrockAgentCoreControlClient, CreateMemoryCommand, GetMemoryCommand } from "@aws-sdk/client-bedrock-agentcore-control";

if (process.argv.includes("--help")) {
  console.log("AWS_REGION=us-west-2 AWS_SNAPSHOT_BUCKET=<existing-private-bucket> pnpm create-memory --confirm\nCreates one billable AgentCore Memory with facts and preferences. Does not create a bucket or IAM role.");
} else {
  if (!process.argv.includes("--confirm")) throw new Error("Creating AWS resources requires --confirm. Run with --help first.");
  const region = process.env.AWS_REGION;
  if (!region) throw new Error("Set AWS_REGION to your approved testing region.");
  if (!process.env.AWS_SNAPSHOT_BUCKET) throw new Error("Set AWS_SNAPSHOT_BUCKET to an existing private bucket without snapshot expiration rules.");
  const name = process.env.AWS_MEMORY_NAME ?? "EveAgentMemory";
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(name)) throw new Error("AWS_MEMORY_NAME must start with a letter and contain up to 48 letters, digits or underscores.");
  const client = new BedrockAgentCoreControlClient({ region });
  const signal = AbortSignal.timeout(300_000);
  const response = await client.send(new CreateMemoryCommand({
    name,
    clientToken: name,
    eventExpiryDuration: 7,
    ...(process.env.AWS_MEMORY_EXECUTION_ROLE_ARN ? { memoryExecutionRoleArn: process.env.AWS_MEMORY_EXECUTION_ROLE_ARN } : {}),
    memoryStrategies: [
      { semanticMemoryStrategy: { name: "Facts", namespaceTemplates: ["/eve/actors/{actorId}/facts/"] } },
      { userPreferenceMemoryStrategy: { name: "Preferences", namespaceTemplates: ["/eve/actors/{actorId}/preferences/"] } },
    ],
  }), { abortSignal: signal });
  const id = response.memory?.id;
  if (!id) throw new Error("AWS returned no memory ID.");
  console.log(`Created/requested memory ${id}. Waiting for memory and strategies to become ACTIVE.\nIf this script fails, inspect that resource before creating another.`);
  while (true) {
    const current = await client.send(new GetMemoryCommand({ memoryId: id }), { abortSignal: signal });
    const memory = current.memory;
    if (memory?.status === "FAILED" || memory?.strategies?.some((strategy) => strategy.status === "FAILED")) {
      throw new Error(`Memory activation failed: ${memory?.failureReason ?? "inspect AWS strategy logs"}`);
    }
    if (memory?.status === "ACTIVE" && memory.strategies?.length === 2 && memory.strategies.every((strategy) => strategy.status === "ACTIVE")) break;
    await setTimeout(5_000, undefined, { signal });
  }
  console.log(`Ready. Set AWS_MEMORY_ID=${id}\nEvent retention is 7 days. Long-term records and S3 snapshots need separate cleanup. No bucket, role, or resource deletion was performed.`);
}
