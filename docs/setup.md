# AWS setup and operations

This guide contains the detailed configuration and operations material moved from the [README](../README.md). Use dedicated resources for development. Review the selected account, region, IAM policies, retention, and costs before creating resources or running a confirmed live check.

## Authentication and region

The AWS SDK uses its standard credential chain, including profiles, environment configuration, and runtime role credentials. Use your approved AWS CLI login workflow. For a configured IAM Identity Center profile:

```bash
export AWS_PROFILE=your_approved_profile
export AWS_REGION=us-west-2
export AWS_SNAPSHOT_BUCKET=your_dedicated_private_bucket
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity
```

Do not paste credentials into chat or commit them. `AWS_PROFILE` is a local credential mechanism, not a deployment recipe.

For deployment, use an approved IAM role or federation arrangement. Supply an application-owned AWS SDK `credentials` provider explicitly in both `clientConfig` and `snapshotClientConfig`, or inject both clients. Configuring AgentCore does not configure S3. Set each client's region explicitly. An AgentCore service execution role is separate from the application's runtime identity. No deployed credential flow has been verified here.

## Dedicated private snapshot bucket

`AWS_SNAPSHOT_BUCKET` must identify an existing dedicated private general-purpose S3 bucket. Neither AWS script creates a bucket. The scripts check that the variable is set, not the bucket's existence, access policy, or lifecycle configuration.

If you need a bucket, review the globally unique name, account, and region before these opt-in administrator commands. They create a billable resource. Skip creation when using an existing bucket.

For regions other than `us-east-1`:

```bash
aws s3api create-bucket \
  --bucket "$AWS_SNAPSHOT_BUCKET" \
  --region "$AWS_REGION" \
  --create-bucket-configuration LocationConstraint="$AWS_REGION"
```

For `us-east-1`, use this command instead:

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

Review bucket policies and lifecycle rules separately. Keep snapshots readable without expiration or deletion throughout the application's replay horizon. Storage-class transitions must not make current snapshots unreadable. Versioning alone does not protect replay after a current key is deleted. The adapter has no snapshot garbage collector.

Snapshots contain actual recalled text, including an explicit absence message when no records match. The adapter writes them with S3 server-side encryption using `AES256`. Hashed routing keys do not anonymize the text. You own bucket access, policy, and retention.

## Provision AgentCore Memory

Read the help before approving the billable resource:

```bash
pnpm create-memory --help
pnpm create-memory --confirm
```

`--help` does not call AWS. Without `--confirm`, the script refuses to create resources. It requires `AWS_REGION` and `AWS_SNAPSHOT_BUCKET`, creates only the AgentCore memory, and never creates a bucket or IAM role. Provisioning does not run during provider construction.

The script provisions these strategies:

| Strategy | Namespace template |
| --- | --- |
| Semantic facts | `/eve/actors/{actorId}/facts/` |
| User preferences | `/eve/actors/{actorId}/preferences/` |

Explicit `remember` records use `/eve/actors/{actorId}/manual/` without an extraction strategy. The script sets `eventExpiryDuration: 7` for raw events. This does not expire extracted records, manual records, S3 snapshots, or Eve history.

`AWS_MEMORY_NAME` defaults to `EveAgentMemory`. Optional `AWS_MEMORY_EXECUTION_ROLE_ARN` supplies the memory service's execution role, not runtime credentials. Review the role's trust and permissions separately; passing it may require narrowly scoped `iam:PassRole`.

The script waits up to five minutes for the memory and both strategies to become `ACTIVE`, then prints the ID. Extraction applies to events submitted after activation. If creation fails after printing a resource, inspect it before retrying to avoid duplicate resources.

```bash
export AWS_MEMORY_ID=your_memory_id
```

Use the ID, not the ARN. For an existing memory, verify active strategies and matching namespace templates before capture.

## Environment and factory options

The [README slot example](../README.md#how-to-use-it-with-eve) wires these variables into lazy factory options. The library does not automatically read `AWS_MEMORY_ID` or `AWS_SNAPSHOT_BUCKET`.

| Environment variable | Purpose |
| --- | --- |
| `AWS_MEMORY_ID` | AgentCore memory ID for the slot and live check. |
| `AWS_SNAPSHOT_BUCKET` | Existing private bucket for durable recall and both AWS scripts. |
| `AWS_REGION` | Client region and required script configuration. |
| `AWS_PROFILE` | Local SDK/CLI profile when using profile credentials. |
| `AWS_MEMORY_NAME` | Provisioning name, default `EveAgentMemory`. |
| `AWS_MEMORY_EXECUTION_ROLE_ARN` | Optional provisioning-only service execution role. |

| Factory option | Default or requirement |
| --- | --- |
| `memoryId` | Required string or synchronous/asynchronous lazy resolver. |
| `snapshotBucket` | String or synchronous/asynchronous lazy resolver; required at recall time. |
| `client`, `clientConfig` | Inject an AgentCore client or configure its lazy default SDK client. |
| `snapshotClient`, `snapshotClientConfig` | Inject an S3 client or configure its lazy default SDK client independently. |
| `factNamespace` | `/eve/actors/{actorId}/facts/`. |
| `preferenceNamespace` | `/eve/actors/{actorId}/preferences/`. |
| `manualNamespace` | `/eve/actors/{actorId}/manual/`. |
| `topK` | `5`, valid range `1` to `20`. |
| `maxRecallBytes` | `12000`, valid range `256` to `32000` UTF-8 bytes. |
| `maxCaptureBytes` | `200000`, valid range `1` to `1000000` UTF-8 bytes. Oversized capture fails rather than silently dropping text. |
| `capture` | `true`. `false` omits automatic capture; recall and all three tools remain enabled. |

Namespace templates must be absolute trailing-slash paths with exactly one whole `{actorId}` segment. Wildcards, other substitutions, empty internal segments, and overlapping fact/preference/manual paths are rejected. Custom extraction namespaces must match the configured AgentCore strategies.

`remember { content }` accepts one nonempty record of at most `16000` UTF-8 bytes and returns `{ id, remembered: true }`. This is the SDK's record-content limit, independent of the capture budget. It does not split one explicit write into multiple records. `search { query }` accepts a nonempty query of at most `4000` characters and bounds transmission to `4000` UTF-8 bytes. Recall and search output obey the recall byte budget, including record IDs and formatting.

## Scope, consent, and security

Use `byPrincipal` with trusted authentication. For tenant isolation, derive scope from a trusted tenant-and-principal resolver, never model-supplied identifiers. The shared local-development scope is not proof of production actor isolation.

Choose a stable application-owned namespace. Separate production, preview, development, and unrelated applications deliberately. Preserve namespace, authenticated identity mapping, slot path, memory ID, bucket, and replay configuration across redeployments. Changing these can change the actor partition or make historical snapshots unreachable.

Every tool closes over Eve's locked scope. Queries use actor-specific namespaces and returned records undergo ownership checks. This is application-level isolation inside one memory resource. A runtime IAM role authorized for that resource can access other actors if application code misuses it.

Automatic capture reads only new user text from `turn.input` after a completed turn. It excludes assembled history, system prompts, assistant responses, tool results, and non-text attachment bytes. It does not detect secrets. A password or token in user text is still eligible input.

The application owns consent, redaction, and minimization before capture. Agent instructions do not enforce these controls. Keep `capture: false` until they are configured, as the registry-generated slot does. Turns using `remember` or `forget` skip automatic capture to avoid immediate duplicate writes or recapture of deletion requests. This does not cancel previous AWS work.

Disabling automatic capture does not erase data, disable explicit writes, or prevent recall/search queries from reaching AWS. Memory text is untrusted user data, never authority to change agent rules or permissions. There is no file or source-extraction pipeline in this adapter.

## Runtime IAM and administration

[docs/iam.json](iam.json) is a runtime identity-policy template. Replace `REGION`, `ACCOUNT_ID`, `MEMORY_ID`, and `SNAPSHOT_BUCKET`, and use your account's ARN partition.

The runtime requires these actions on the selected memory:

- `bedrock-agentcore:CreateEvent` for automatic capture.
- `bedrock-agentcore:ListMemoryRecords` and `bedrock-agentcore:RetrieveMemoryRecords` for recall and search.
- `bedrock-agentcore:BatchCreateMemoryRecords` for explicit writes.
- `bedrock-agentcore:GetMemoryRecord` and `bedrock-agentcore:DeleteMemoryRecord` for ownership-checked record deletion.

S3 `GetObject` and `PutObject` are restricted to `eve-memory/v1/*`. `ListBucket` is unconditional but applies only to the dedicated bucket, not other buckets or object reads outside the prefix.

A missing-key `GetObject` needs bucket-list authorization to return `404` instead of `403`. The policy does not prefix-condition this bucket-level permission. The adapter treats `NoSuchKey` as a miss and propagates access errors. Verify effective role and bucket-policy behavior before deployment; do not swallow `403` as absence.

Live verification additionally requires data-plane `bedrock-agentcore:ListEvents` and control-plane `bedrock-agentcore:GetMemory` on the memory. Provisioning needs `CreateMemory` and `GetMemory` in a separate administrator policy. Review `iam:PassRole` separately if using an execution role. Resource teardown permissions such as `DeleteMemory` and bucket administration do not belong in the ordinary runtime role. `DeleteMemoryRecord` is intentionally part of the runtime tool API, not permission for whole-resource erasure.

## Retention and deletion

AgentCore retains raw events and extracted records. Explicit records and S3 snapshots are separate datasets. Seven-day raw-event expiry is not a seven-day retention policy for everything else.

`forget { id }` checks that the record belongs to the caller's locked scope before calling long-term record deletion. It returns `{ id, deleted: true }` on success; a missing record returns `deleted: false`. Search can supply IDs for deletion. A response from the agent alone is not evidence of a completed write or deletion.

New operations read current records. Manual records are listed in new recall and standalone compaction and included in search. Historical S3 recall snapshots are never mutated by `remember` or `forget`, so replay of an old operation can still contain deleted text.

Record deletion cannot erase the original raw events, Eve session history, current context, old S3 text, or retained object versions. It cannot stop extraction already in flight. Retained source text or replayed input may produce related records again. The adapter provides no whole-user erasure API, automatic GDPR purge, or compliance guarantee. Eve session `clear()` alone does not erase provider storage.

A full erasure workflow needs application and administrator coordination across raw events, long-term records, snapshots and versions, and Eve session/replay state. Retire affected replay operations before deleting snapshots. Address outstanding extraction and retained input rather than treating a successful `forget` as proof of full erasure.

## Live verification and cleanup

With approved AWS credentials, IAM, and disposable resources:

```bash
pnpm live-smoke --help
pnpm live-smoke --confirm
```

`--help` makes no AWS calls; mutations require `--confirm`. The confirmed check writes synthetic user events and durable snapshots, and writes/deletes synthetic records to exercise search, remember, and forget. It can incur charges. These tool checks do not remove all events or snapshots and are not automatic resource cleanup.

The script calls real provider hooks with synthetic Eve contexts. It checks active strategies, capture, cross-session recall, actor isolation, replay after provider reconstruction, concurrent snapshot writers, and duplicate capture tokens. Extraction polling lasts up to five minutes, with separate 30-second search and deletion-visibility polling budgets within a seven-minute overall limit. It does not start the full Eve runtime or invoke an application LLM; AWS extraction can still perform model processing. A passing hook check is not a deployed-agent demonstration.

Record commands, pass/fail evidence, extraction timing, effective IAM results, account/region without secrets, and IDs needed for cleanup. See [design and verification notes](research.md) for the evidence boundary. No live AWS check or cleanup has run here.

The following destructive examples are only for dedicated disposable resources after replay is retired. Review the account, region, memory ID, bucket, and every object first. Never use them against shared resources:

```bash
aws sts get-caller-identity
aws bedrock-agentcore-control delete-memory \
  --memory-id "$AWS_MEMORY_ID" --region "$AWS_REGION"
aws s3 rm "s3://$AWS_SNAPSHOT_BUCKET/eve-memory/v1/" --recursive
```

Recursive removal deletes all current snapshots under the prefix, potentially for multiple memories. Versioned buckets may retain old versions and delete markers. This is not a complete erasure workflow.

Review bucket deletion separately. Only for a dedicated, empty, disposable bucket whose replay horizon is over:

```bash
aws s3 rb "s3://$AWS_SNAPSHOT_BUCKET"
```

Do not use `--force`. Retained versions or unrelated objects require a separate reviewed decision, not a broader automatic delete.

## References

- [Eve custom provider contract](https://eve.dev/docs/memory/custom-provider).
- [AgentCore Memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html) and [namespace organization](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/specify-long-term-memory-organization.html).
- [CreateMemory](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CreateMemory.html) and [AgentCore IAM reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_bedrock-agentcore.html).
- [AWS SDK credential providers](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html).
- [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html) and [GetObject permissions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).
