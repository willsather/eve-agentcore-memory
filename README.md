# Eve AgentCore Memory

`eve-agentcore-memory` is an alpha TypeScript memory provider for Eve. It captures new user text into Amazon Bedrock AgentCore Memory, recalls extracted facts and preferences, and stores durable recall snapshots in a private S3 bucket. Eve runs the agent and owns its sessions. AgentCore Runtime is not required.

The prototype is locally unit-tested. Live AWS behavior and a deployed Eve agent remain unverified pending AWS login and a separate deployment check. This package is not published to npm.

## What the adapter does

- Captures nonempty user text from `turn.input` after a completed turn. It does not ingest assembled history, system prompts, assistant responses, tool results, or non-text attachments.
- Uses AgentCore semantic and user-preference strategies under `/eve/actors/{actorId}/facts/` and `/eve/actors/{actorId}/preferences/`.
- Recalls before a turn and after compaction. Standalone compaction reads preferences without inventing a search query.
- Exposes one scope-bound `search` tool. There are no `remember` or `forget` tools, source extraction, or whole-user erasure API.
- Uses S3 conditional writes to keep recall stable when Eve replays an operation after a restart.

AgentCore extraction is asynchronous. A newly captured fact may take a minute or more to appear. Eve's session history handles immediate conversation continuity.

## Quick start

Use Node.js 24 and pnpm 12.9.1. Development pins Eve to `0.71.3`; the peer range is `>=0.71.3 <1`, but other Eve versions have not been verified.

### Clone and build

Once the repository is available to your account:

```bash
git clone https://github.com/willsather/eve-agentcore-memory.git
cd eve-agentcore-memory
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

The build writes the library to `dist/`. Local tests use mocked AWS clients, not an AWS account or an LLM. The deterministic suite, typecheck, and build passed on Node.js 26.7.0 with pnpm 12.9.1. That run does not verify Node.js 24 or a deployed agent.

### Authenticate and supply a dedicated private bucket

Use your approved AWS CLI login or profile workflow. The AWS SDK uses its standard credential chain, including profiles, environment configuration, and runtime role credentials. Do not paste credentials into chat or commit them to this repository.

For a configured IAM Identity Center profile:

```bash
export AWS_PROFILE=your_approved_profile
export AWS_REGION=us-east-1
export AWS_SNAPSHOT_BUCKET=your_dedicated_private_bucket
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity
```

`AWS_SNAPSHOT_BUCKET` is mandatory for durable recall. Supply an existing dedicated private general-purpose S3 bucket with public access blocked. Neither AWS script creates a bucket. Keep snapshots accessible, without expiration or deletion, throughout the application's replay horizon. A seven-day event expiry is not a seven-day snapshot retention policy.

If you need a new bucket, review the account, region, and globally unique bucket name before running these manual commands. This is an opt-in administrator step that creates a billable resource, not automatic script setup. Skip bucket creation when using an existing bucket.

For regions other than `us-east-1`:

```bash
aws s3api create-bucket \
  --bucket "$AWS_SNAPSHOT_BUCKET" \
  --region "$AWS_REGION" \
  --create-bucket-configuration LocationConstraint="$AWS_REGION"
```

For `us-east-1`, omit the bucket configuration instead:

```bash
aws s3api create-bucket \
  --bucket "$AWS_SNAPSHOT_BUCKET" \
  --region us-east-1
```

Run only the creation command for your region, then block public access:

```bash
aws s3api put-public-access-block \
  --bucket "$AWS_SNAPSHOT_BUCKET" \
  --region "$AWS_REGION" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

Review bucket policies and lifecycle rules separately. Do not enable snapshot expiration or deletion during the replay horizon. The runtime policy does not grant bucket creation or public-access configuration permissions.

### Provision the memory explicitly

`scripts/create-memory.ts` requires `AWS_REGION` and `AWS_SNAPSHOT_BUCKET`. The bucket must already exist and be private; the script checks that the bucket variable is set, not the bucket's existence, access policy, or lifecycle rules. It creates only the AgentCore memory, never a bucket or IAM role.

Read the help first, then run the confirmed command only after approving the account, region, and billable resource:

```bash
pnpm create-memory --help
pnpm create-memory --confirm
```

`--help` does not call AWS. Without `--confirm`, the script refuses to create resources. The confirmed command provisions semantic facts and user preferences with the exact namespaces above and `eventExpiryDuration: 7` for raw events. `AWS_MEMORY_NAME` is optional and defaults to `EveAgentMemory`. `AWS_MEMORY_EXECUTION_ROLE_ARN` is optional and supplies the memory service's execution role, not the application's runtime credentials. Provisioning never runs during provider construction.

The script waits up to five minutes for both the memory and its strategies to become `ACTIVE`, then prints the memory ID. If it fails after requesting creation, inspect the printed resource before retrying. Extraction applies to events submitted after the strategies become active. Set `AWS_MEMORY_ID` to the resulting memory ID, not its ARN:

```bash
export AWS_MEMORY_ID=your_memory_id
```

If you use an existing memory, check its active strategies and namespace templates first. Obtain provisioning permissions separately from the runtime policy in [docs/iam.json](docs/iam.json), including `CreateMemory` and `GetMemory` for the activation wait.

### Install a local package in your Eve application

Build and pack the library, then install its tarball from the consuming application:

```bash
pnpm build
pnpm pack
cd /path/to/your/eve-app
pnpm add /path/to/eve-agentcore-memory/eve-agentcore-memory-0.1.0.tgz
```

Do not use a registry install for `eve-agentcore-memory`; it is not published. Run `pnpm build` followed by `pnpm pack-smoke` to check packed ESM imports, exports, and lazy provider construction without AWS credentials. The smoke script reuses the repository's installed dependencies; testing a fresh consumer install is a separate check from the unit suite.

### Declare an Eve memory slot

Create `agent/memory/aws.ts` in the consuming application:

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
  description: "Recall durable facts and preferences for the authenticated caller.",
  scope: byPrincipal,
  provider: agentCoreMemory({
    memoryId: () => requiredEnv("AWS_MEMORY_ID"),
    snapshotBucket: () => requiredEnv("AWS_SNAPSHOT_BUCKET"),
    clientConfig: { region: process.env.AWS_REGION },
    snapshotClientConfig: { region: process.env.AWS_REGION },
  }),
});
```

The memory ID and bucket resolve lazily when a hook runs. Default AWS clients also initialize lazily, so provider construction does not require AWS login. `snapshotBucket` is optional in the TypeScript interface but required at recall time.

Replace the example namespace with an application-owned stable namespace. Separate production, preview, development, and unrelated applications deliberately. Keep namespace, authenticated identity mapping, memory ID, bucket, and replay configuration stable across redeployments. Changing them can change the actor partition or make old snapshots unreachable. Keep the slot path stable too, because Eve operation identity includes the slot.

`byPrincipal` derives scope from trusted authentication. For tenant-specific isolation, use a trusted tenant-and-principal resolver rather than model-supplied identifiers. Eve's local development helper uses a shared local-dev scope; it is not evidence of production actor isolation.

## Environment and options

| Environment variable | Purpose |
| --- | --- |
| `AWS_MEMORY_ID` | AgentCore memory ID used by the sample's lazy resolver. |
| `AWS_SNAPSHOT_BUCKET` | Existing dedicated private S3 bucket used by the sample and required by both AWS scripts. |
| `AWS_REGION` | Region for AWS clients and required provisioning configuration. |
| `AWS_PROFILE` | Local SDK/CLI profile, when using profile-based credentials. Not a deployment credential mechanism. |
| `AWS_MEMORY_NAME` | Provisioning-only name, default `EveAgentMemory`. |
| `AWS_MEMORY_EXECUTION_ROLE_ARN` | Optional provisioning-only execution role for the memory service. |

The library does not read `AWS_MEMORY_ID` or `AWS_SNAPSHOT_BUCKET` automatically. Supply them through the factory options as shown above.

| Factory option | Default or requirement |
| --- | --- |
| `memoryId` | Required string or synchronous/asynchronous lazy resolver. |
| `snapshotBucket` | String or synchronous/asynchronous lazy resolver; required for recall. |
| `client`, `clientConfig` | Inject an AgentCore client or configure its default AWS SDK client. |
| `snapshotClient`, `snapshotClientConfig` | Inject an S3 client or configure its default AWS SDK client independently. |
| `factNamespace` | `/eve/actors/{actorId}/facts/`. |
| `preferenceNamespace` | `/eve/actors/{actorId}/preferences/`. |
| `topK` | `5`, valid range `1` to `20`. |
| `maxRecallBytes` | `12000`, valid range `256` to `32000` UTF-8 bytes. |
| `maxCaptureBytes` | `200000`, valid range `1` to `1000000` UTF-8 bytes. Oversized input fails capture rather than silently dropping text. |
| `capture` | `true`. Set `false` to omit automatic capture. Recall and search remain enabled. |

Namespace templates must be absolute paths with a trailing slash and exactly one whole `{actorId}` segment. Wildcards, other substitutions, and overlapping fact/preference paths are rejected. Custom paths must match the strategies configured in AgentCore.

## Consent, retention, and erasure

Automatic capture includes all eligible new user text, subject to the capture byte budget. It is not inherently secret-filtered. A password or token inside a user message is still user text. Agent instructions such as "never save secrets" do not filter this provider's automatic capture.

Your application owns consent, redaction, and data minimization before text reaches the capture hook. Use `capture: false` until capture is appropriate, or keep capture disabled if you cannot meet those obligations. Disabling capture does not erase existing data or prevent recall and search from transmitting queries to AWS.

AgentCore stores raw events and extracted records. S3 snapshots contain the actual recalled text, including an explicit empty-context message when no records match. Hashing routing identifiers does not anonymize that text. The adapter writes snapshots with S3 server-side encryption using `AES256`; you still own bucket access, policy, and retention.

Keep the bucket private. Do not expire, overwrite, delete, or make snapshot objects unreadable while their operations can replay. Apply the same rule to bucket lifecycle rules, administrator cleanup, and storage-class transitions. Versioning alone does not protect replay if the current key is deleted. The adapter has no snapshot garbage collector.

Erasure must address raw AgentCore events, extracted records, all relevant S3 snapshots and retained versions, and Eve session/replay state. Deleting a record alone leaves its text in snapshots and possibly Eve history. Replaying retained input may recreate deleted data. Retire affected replay operations as part of a reviewed erasure workflow before deleting their snapshots. The adapter provides no automatic GDPR purge, no complete erasure implementation, and no compliance guarantee. Eve session `clear()` alone does not erase provider storage.

## IAM and deployment

[docs/iam.json](docs/iam.json) is a runtime identity-policy template. Replace `REGION`, `ACCOUNT_ID`, `MEMORY_ID`, and `SNAPSHOT_BUCKET` before applying it. Use the appropriate ARN partition for your account.

The runtime needs resource-specific `bedrock-agentcore:CreateEvent`, `bedrock-agentcore:ListMemoryRecords`, and `bedrock-agentcore:RetrieveMemoryRecords` on one memory. S3 `GetObject` and `PutObject` remain restricted to `eve-memory/v1/*`. `ListBucket` is unconditional but applies only to the one dedicated private bucket, allowing its keys to be listed without granting object reads outside the snapshot prefix.

A missing-key `GetObject` needs bucket list authorization to return `404` rather than `403`. The policy does not use a prefix condition for this bucket-level permission. The adapter treats `NoSuchKey` as a cache miss and propagates access errors. Verify the missing-key behavior with the exact effective role and bucket policy before use; that check remains unverified.

The live-smoke script additionally needs data-plane `bedrock-agentcore:ListEvents` and control-plane `bedrock-agentcore:GetMemory` on that memory. Provisioning needs control-plane `bedrock-agentcore:CreateMemory` and `bedrock-agentcore:GetMemory` for the activation wait in a separate administrator policy. Passing an execution role may also require narrowly scoped `iam:PassRole`. Do not add provisioning or deletion permissions to the ordinary runtime role.

For Vercel deployment, obtain runtime AWS credentials through an approved IAM role or federation arrangement. Use an application-owned credential provider explicitly in both `clientConfig` and `snapshotClientConfig`; configuring one does not configure the other. Each can receive the AWS SDK `credentials` provider and its own `region`. The local profile example is not a production federation recipe. No deployed credential flow has been verified here.

## Live verification and cleanup

After approving AWS access and reviewing the selected memory, bucket, IAM, and costs, read the help and explicitly confirm the live write:

```bash
pnpm live-smoke --help
pnpm live-smoke --confirm
```

`--help` does not call AWS. Without `--confirm`, the script refuses to write data. The confirmed command writes synthetic user text to the selected memory and durable snapshots to the bucket, and can incur AWS charges. It performs no automatic cleanup.

The live check calls the real provider hooks with synthetic Eve contexts against AWS. It checks active strategies and namespaces, capture, cross-session recall, another actor's isolation, replay after provider reconstruction, concurrent snapshot writers, and duplicate capture tokens. Extraction polling lasts up to five minutes within a six-minute overall budget. It does not run the full Eve runtime or invoke an application LLM. AWS's extraction service may still perform model processing and incur charges. A passing hook smoke test is not a deployed-agent demonstration.

No live check or cleanup has run. See [docs/research.md](docs/research.md) for the evidence boundary and design decisions.

The following destructive commands are for dedicated disposable resources only, after replay is retired and you review the account, region, memory ID, bucket, and every object. Never run them against shared resources:

```bash
aws sts get-caller-identity
aws bedrock-agentcore-control delete-memory \
  --memory-id "$AWS_MEMORY_ID" --region "$AWS_REGION"
aws s3 rm "s3://$AWS_SNAPSHOT_BUCKET/eve-memory/v1/" --recursive
```

Recursive removal deletes all current snapshots under the prefix, potentially for multiple memories. In a versioned bucket it can leave old versions and delete markers. It is not a complete erasure workflow.

Review bucket deletion separately. Only for a dedicated, empty, disposable bucket whose replay horizon is over:

```bash
aws s3 rb "s3://$AWS_SNAPSHOT_BUCKET"
```

Do not use `--force`. Retained versions or unrelated objects require a separate reviewed decision, not a broader automatic delete.

## Sources

- [Eve memory overview](https://eve.dev/docs/memory) and [custom provider contract](https://eve.dev/docs/memory/custom-provider).
- [AgentCore Memory overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html), [long-term extraction and retrieval](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/long-term-saving-and-retrieving-insights.html), and [namespace organization](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/specify-long-term-memory-organization.html).
- [AWS CreateMemory](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CreateMemory.html) and [AgentCore IAM reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_bedrock-agentcore.html).
- [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html) and [GetObject permissions and missing-key errors](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).
- [Supermemory's Eve adapter](https://github.com/supermemoryai/eve-supermemory) is a reference for adapter responsibilities, not a claim of feature parity. This adapter leaves extraction and indexing to AWS and offers only automatic capture, recall, and search.
