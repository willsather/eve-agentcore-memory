# Eve AgentCore Memory

## What it is

`eve-agentcore-memory` is a TypeScript memory provider for Eve backed by Amazon Bedrock AgentCore Memory and private S3 recall snapshots. Eve runs the agent and owns its sessions. AgentCore Runtime is not required.

Alpha: local typechecking and mock tests are verified; live AWS and a deployed Eve agent are not. The package is not published to npm or accepted into Eve's registry yet.

- Captures new user text after completed turns, when automatic capture is enabled.
- Recalls facts, preferences, and explicit records before turns and after compaction.
- Provides scope-bound `search { query }`, `remember { content }`, and `forget { id }` tools.
- Keeps historical recall snapshots unchanged so replay returns the same context.

`remember` writes one direct long-term record and returns its ID. Content is limited to 16,000 UTF-8 bytes. Manual records use `/eve/actors/{actorId}/manual/` and participate in new recall, standalone compaction, and search. Automatic extraction is asynchronous; extracted facts may take a minute or more to appear.

`forget` checks caller scope before deleting one long-term record. It does not erase original raw events, Eve history, or old S3 text, and cannot stop AWS extraction already in flight. It is not full privacy erasure. See [setup and deletion guidance](docs/setup.md#retention-and-deletion).

## How to use it with Eve

Intended command after npm publication and acceptance in Eve's registry, not an available official integration today:

```bash
eve add memory/agentcore
```

The registration plan is in [docs/registry.md](docs/registry.md). The generated slot uses `byPrincipal` and `capture: false` until the application configures consent and redaction. The factory itself defaults to `capture: true`.

For now, build and install a local packed tarball:

```bash
cd /path/to/eve-agentcore-memory
pnpm install
pnpm build
pnpm pack
cd /path/to/your/eve-app
pnpm add /path/to/eve-agentcore-memory/eve-agentcore-memory-0.1.0.tgz
```

Create `agent/memory/aws.ts` in your Eve application:

```ts
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { agentCoreMemory } from "eve-agentcore-memory";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

export default defineMemory({
  namespace: "your-app-production-memory-v1",
  description: "Recall facts and preferences for the authenticated caller.",
  scope: byPrincipal,
  provider: agentCoreMemory({
    memoryId: () => requiredEnv("AWS_MEMORY_ID"),
    snapshotBucket: () => requiredEnv("AWS_SNAPSHOT_BUCKET"),
    clientConfig: { region: process.env.AWS_REGION },
    snapshotClientConfig: { region: process.env.AWS_REGION },
    capture: false,
  }),
});
```

Memory ID, bucket, and default clients resolve lazily. Construction does not require AWS login. The library does not automatically read those two environment variables.

Use trusted authentication for `byPrincipal`; add trusted tenant identity when needed. Choose a stable application namespace and preserve the slot path, identity mapping, memory ID, and bucket across redeployments. Local development's shared scope does not prove production isolation.

Enable automatic capture only after application consent and redaction are configured. It captures user text, including secrets if supplied; agent instructions do not filter it. Turns using `remember` or `forget` skip automatic capture to avoid immediately duplicating explicit writes or recapturing deletion requests. Disabling capture leaves recall and tools enabled.

## AWS setup

Use an approved AWS profile and an existing dedicated private bucket. Neither setup script creates a bucket or IAM role.

```bash
export AWS_PROFILE=your_approved_profile
export AWS_REGION=us-west-2
export AWS_SNAPSHOT_BUCKET=your_dedicated_private_bucket
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity

cd /path/to/eve-agentcore-memory
pnpm create-memory --help
pnpm create-memory --confirm
export AWS_MEMORY_ID=your_created_memory_id
```

Review the account, region, permissions, and costs before `--confirm`. Provisioning creates semantic and preference strategies, waits for activation, and prints the memory ID. Raw events expire after seven days; this is not a snapshot or extracted-record retention policy.

[Full setup guide](docs/setup.md) covers private bucket creation, configuration options, runtime IAM, execution roles, authentication, security, retention, deletion, and disposable-resource cleanup. Never commit credentials or paste them into chat.

## Local run, test, and build

Requires Node.js `>=24` and pnpm `12.9.1`. Development uses Eve `0.71.3`; the peer range is `>=0.71.3 <1`, not a guarantee for every version.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack-smoke
```

The build writes `dist/`. Tests use mocked AWS clients. `pack-smoke` checks packed ESM imports and lazy provider construction using installed dependencies, not a fresh consumer installation.

Optional live hook check, only with approved AWS credentials and disposable resources:

```bash
pnpm live-smoke --help
pnpm live-smoke --confirm
```

The confirmed check writes synthetic events and S3 snapshots and writes/deletes synthetic long-term records. It can incur charges and does not clean up all resources. It tests provider hooks, not a full Eve runtime or deployment. See [live verification and cleanup](docs/setup.md#live-verification-and-cleanup) and [design evidence](docs/research.md).
