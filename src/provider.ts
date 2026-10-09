import { defineMemoryProvider, type MemoryProvider } from "eve/memory";
import { capture } from "./lib/capture.js";
import { resolveOptions, type AgentCoreMemoryOptions } from "./options.js";
import { loadRecall, type RecallContext } from "./lib/recall.js";
import { createSnapshots } from "./lib/snapshots.js";
import { createTools } from "./tools/index.js";

export function agentCoreMemory(options: AgentCoreMemoryOptions): MemoryProvider {
  const config = resolveOptions(options);
  const recallSnapshot = createSnapshots({ bucket: options.snapshotBucket, client: options.snapshotClient, clientConfig: options.snapshotClientConfig });
  async function recall(context: RecallContext) {
    context.abortSignal.throwIfAborted();
    const connection = await config.connection();
    context.abortSignal.throwIfAborted();
    return recallSnapshot(connection, context, config, () => loadRecall(connection, context, config));
  }
  return defineMemoryProvider({
    recall: { "turn.started": recall, "compaction.completed": recall },
    ...(config.capture ? { capture: { "turn.completed": (context) => capture(context, config) } } : {}),
    async tools(context) {
      return createTools(context, config);
    },
  });
}
