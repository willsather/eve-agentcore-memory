import { BedrockAgentCoreClient, type BedrockAgentCoreClientConfig } from "@aws-sdk/client-bedrock-agentcore";
import type { S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import { z } from "zod";

export interface AgentCoreMemoryOptions {
  memoryId: string | (() => string | Promise<string>);
  client?: BedrockAgentCoreClient;
  clientConfig?: BedrockAgentCoreClientConfig;
  snapshotBucket?: string | (() => string | Promise<string>);
  snapshotClient?: S3Client;
  snapshotClientConfig?: S3ClientConfig;
  factNamespace?: string;
  preferenceNamespace?: string;
  topK?: number;
  maxRecallBytes?: number;
  maxCaptureBytes?: number;
  capture?: boolean;
}

const template = z.string().max(900).refine((value) => {
  const parts = value.split("/");
  return value.startsWith("/") && value.endsWith("/") &&
    parts.filter((part) => part === "{actorId}").length === 1 &&
    parts.slice(1, -1).every((part) => part === "{actorId}" || /^[a-zA-Z0-9_-]+$/.test(part));
}, "Namespace must be an absolute trailing-slash path with exactly one {actorId} segment and no wildcards or other variables.");

const schema = z.object({
  factNamespace: template.default("/eve/actors/{actorId}/facts/"),
  preferenceNamespace: template.default("/eve/actors/{actorId}/preferences/"),
  topK: z.number().int().min(1).max(20).default(5),
  maxRecallBytes: z.number().int().min(256).max(32_000).default(12_000),
  maxCaptureBytes: z.number().int().min(1).max(1_000_000).default(200_000),
  capture: z.boolean().default(true),
});

export function resolveOptions(options: AgentCoreMemoryOptions) {
  if (typeof options.memoryId !== "function" && !options.memoryId?.trim()) {
    throw new Error("memoryId must be a nonempty string or lazy resolver.");
  }
  const config = schema.parse(options);
  const facts = config.factNamespace.replace("{actorId}", "actor");
  const preferences = config.preferenceNamespace.replace("{actorId}", "actor");
  if (facts.startsWith(preferences) || preferences.startsWith(facts)) {
    throw new Error("Fact and preference namespaces must not overlap.");
  }
  let client = options.client;
  return {
    ...config,
    async connection() {
      const memoryId = typeof options.memoryId === "function" ? await options.memoryId() : options.memoryId;
      if (!memoryId?.trim()) throw new Error("The memoryId resolver returned an empty value.");
      client ??= new BedrockAgentCoreClient(options.clientConfig ?? {});
      return { client, memoryId };
    },
  };
}

export type Config = ReturnType<typeof resolveOptions>;
