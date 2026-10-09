# Design and verification notes

This alpha adapter connects Eve's memory lifecycle to Amazon Bedrock AgentCore Memory and a private S3 snapshot store. Local code is the implementation authority.

## Evidence and remaining gates

| Check | Evidence or status |
| --- | --- |
| API compatibility | Source and tests use the installed Eve `0.71.3` provider types and bundled custom-provider documentation. The wider peer range is not a compatibility guarantee. |
| Local typecheck | `pnpm typecheck` passed. |
| Local unit suite | The deterministic suite passed with mocked AgentCore and S3 clients using `pnpm test`. |
| Local build | `pnpm build` passed. |
| Test environment | Node.js `26.7.0`, pnpm `12.9.1`. The documented target is Node.js 24; this run did not verify that version. |
| Package distribution | Version `0.1.0`, not npm-published. Packing and an unpacked-artifact import passed with exit code `0`. The import reused installed dependencies; a fresh consumer install remains unverified. Use `pnpm build` followed by `pnpm pack-smoke` for the repository's artifact check. |
| README example | The factory sample compiled against the built API and Eve `0.71.3` with strict TypeScript checks, exit code `0`. Packed-artifact construction also confirmed lazy resolvers and `capture: false` without credentials. |
| Provisioning and live scripts | Source inspection confirms `scripts/create-memory.ts` and `scripts/live-smoke.ts` handle `--help` without AWS calls and require `--confirm` before mutations. No confirmed AWS command has run. |
| Live AWS | Unverified pending login, approved resources, effective IAM checks, and live hook execution. |
| Full Eve runtime and deployment | Unverified. Synthetic hook contexts do not prove runtime authentication, durable scheduling, LLM behavior, or a Vercel deployment. |

Verification uses strict typechecking, deterministic lifecycle and tool tests, actual SDK serialization with no-network transports, and Eve's registry reader against a temporary local HTTP endpoint. Test tooling emits Node deprecation and SDK serializer warnings. These checks do not execute live AWS operations.

The unit suite covers new-user-text capture, mixed content, deterministic capture tokens, UTF-8 budgets, locked scope mapping, namespace validation, pagination, foreign-record rejection, empty recall, standalone compaction, cancellation, error propagation, replay after constructing a new provider, competing snapshot writes, corrupt snapshots, and a smaller replay byte budget. These tests prove the mock-backed paths, not AWS's deployed behavior.

## Who owns what

| Responsibility | Owner |
| --- | --- |
| Agent execution, sessions, authentication, locked memory scope, hook scheduling, and recalled-message attribution | Eve and the consuming application. |
| Raw conversation events, asynchronous semantic extraction, preference extraction, indexing, and record retrieval | AgentCore Memory. |
| Scope mapping, capture selection, bounded queries, recall formatting, cancellation, and write tokens | This adapter. |
| Durable canonical recall result per operation | This adapter using S3 conditional snapshots. |
| Consent, redaction, runtime credentials, bucket lifecycle, retention, erasure, and production verification | The consuming application and resource administrators. |

AgentCore Runtime is not required. The adapter does not replace Eve's conversation history or provide a separate conversation database.

## Capture follows the new delivery

`src/provider.ts` installs capture only at `turn.completed`, unless `capture: false`. `src/lib/capture.ts` reads user-role messages from `turn.input`; `src/lib/text.ts` selects text parts and trims whitespace. It excludes projected history, assistant text, system prompts, tool results, and attachment bytes. Turns using `remember` or `forget` skip automatic capture to avoid immediately duplicating explicit writes or recapturing deletion requests. This does not cancel extraction already in flight.

Other eligible user text is captured, including secrets if the caller typed them. There is no secret detector or redaction pass. Model instructions cannot govern a capture hook that runs independently of model tool choices. The application must obtain consent and redact input before the hook sees it, or disable capture. The factory defaults to `capture: true`; the generated registry slot uses `capture: false` until application consent and redaction are configured. Disabling capture leaves recall and all three tools enabled.

The default aggregate budget is `200000` UTF-8 bytes. Oversized input throws before writes. Text splits at code-point boundaries into chunks no larger than `90000` bytes, with up to `100` payload entries per event. Each request uses a deterministic client token derived from the locked scope key, Eve `operationId`, and chunk offset. A replay generates the same tokens, but timestamps use the current time. AWS duplicate-token behavior, including retries with regenerated timestamps, remains a live-verification gate. Do not claim exactly-once capture from the mock test.

Capture failures propagate from the adapter. Eve `0.71.3` documents completed-turn capture failures as logged after the response; the provider cannot undo that response or guarantee that every delivered message reaches AWS.

## Scope is part of every AWS request

`src/lib/scope.ts` maps Eve's opaque locked scope key to `eve_` followed by a SHA-256 digest. Session IDs hash both the locked scope key and Eve session identity. Raw principal IDs are not AWS routing arguments. `src/lib/records.ts` supplies the shared record namespaces and explicit-write tokens.

Records use these actor-scoped namespace templates. Only facts and preferences require extraction strategies:

| Record kind | Template |
| --- | --- |
| Semantic facts | `/eve/actors/{actorId}/facts/` |
| User preferences | `/eve/actors/{actorId}/preferences/` |
| Explicit manual records | `/eve/actors/{actorId}/manual/` |

The default paths are separate and end in `/`, avoiding prefix collisions such as one actor's ID being a prefix of another. Templates require one whole `{actorId}` segment and reject wildcards, other variables, empty internal segments, and overlapping paths.

Retrieval includes the actor namespace in the AWS query itself. Returned records undergo an additional namespace-prefix check. The adapter does not retrieve globally and then filter for a caller. All tools close over the locked scope and use strict input schemas:

- `src/tools/search.ts` accepts `search { query }`, a nonempty query of at most `4000` characters. Transmission is also bounded to `4000` UTF-8 bytes. It searches manual, fact, and preference namespaces and returns record IDs with byte-bounded text.
- `src/tools/remember.ts` accepts `remember { content }` and uses `BatchCreateMemoryRecords` to write exactly one direct record in the manual namespace. The SDK content limit is `16000` UTF-8 bytes, independent of `maxCaptureBytes`. Success returns `{ id, remembered: true }`. Stable scope, memory, session, turn, and tool-call identities determine the write token. Search visibility can lag creation.
- `src/tools/forget.ts` accepts `forget { id }`, loads the record with `GetMemoryRecord`, checks returned namespaces against the caller's actor namespaces, then calls `DeleteMemoryRecord`. It rejects unverifiable ownership; a missing record returns `deleted: false`. Success deletes one long-term record, not its source events or historical snapshots.

`src/tools/index.ts` assembles the tool set. Explicit tools read or mutate current records directly; they never rewrite historical S3 recall snapshots.

This is application-level actor isolation within a resource. An IAM role authorized for the entire memory can access other actors if application code misuses it. Scope locking does not make that role a separate per-user IAM principal.

Use `byPrincipal` with trusted authentication, and an explicit, stable application namespace. Include a trusted tenant identifier when the application's isolation boundary requires it. Preserve identity mapping, namespace, slot path, memory ID, bucket, and replay configuration across redeployments. A changed namespace derives a different actor partition. A changed bucket or memory ID can hide the old operation's snapshot.

## Recall and compaction

`src/lib/recall.ts` lists manual records and preferences, then searches manual records, facts, and preferences using new user input when a query exists. It deduplicates record IDs and bounds UTF-8 output, including IDs and formatting. Search bounds the serialized tool response too. Retrieval follows pagination with repeated-token detection and a `20`-page safety limit. Default `topK` is `5`; default `maxRecallBytes` is `12000`.

Recall returns one context message with the stable ID `agentcore-context-v1`. A later operation supersedes earlier context in the same Eve slot and scope. When nothing matches, recall returns a nonempty explicit absence message rather than omitting the ID and leaving stale context. Standalone compaction has no invented semantic query and lists manual records and preferences. New operations can see explicit writes and record deletion; old operations replay their unchanged snapshot.

Recalled text is untrusted user data, not instructions. Eve attributes it to the memory slot as user-role content. Prompt injection remains possible; the application must instruct the agent to treat memory as data. The search tool reads current records directly, while lifecycle recall uses a durable snapshot for the operation.

## Why snapshots use S3

AWS event-write idempotency alone cannot make a recall result stable. AgentCore extraction is eventually consistent, so replaying a search later can return new or changed records.

`src/lib/snapshots.ts` stores JSON at:

```text
eve-memory/v1/{digest(memoryId)}/{actorId}/{digest(operationId)}.json
```

The snapshot includes its key, schema `eve-agentcore-recall-v1`, and the actual recalled message text. It stores the absence message too. The algorithm reads the existing snapshot before retrieval. On a miss, it computes recall, writes with `IfNoneMatch: "*"`, and then reads the stored canonical result. A `412` means another writer won; both callers read that winner. Other errors propagate, including `409` conflicts. The adapter does not silently return its provisional result after a failed write.

Malformed JSON, mismatched keys, oversized bodies, and recall content exceeding the current byte budget fail closed. Lowering `maxRecallBytes` can make old snapshots fail validation rather than change historical results. If a snapshot disappears after a write, the operation fails. If it disappears before a future replay's first read, the adapter cannot distinguish deletion from an initial miss and can recompute a different result. That is why retention is a correctness requirement.

Keep the bucket private and its snapshot prefix readable, without expiration or deletion, for the entire replay horizon. Do not use raw-event expiry to size this horizon. Versioning does not help the current-key reader after a delete marker. Preserve snapshots through application upgrades unless affected operations have been retired. The adapter has no automatic snapshot expiration or garbage collection.

AWS documents first-writer conditional semantics and S3 consistency. Mock-backed concurrent-write tests are not a live race test. Verify actual `NoSuchKey`, `412`, and effective IAM behavior against the selected account and bucket before claiming durable replay works in production.

## Retention does not implement erasure

The provisioning script uses `eventExpiryDuration: 7` for raw events. That does not expire extracted facts, S3 snapshots, or Eve history. S3 snapshots contain recalled text and are a separate sensitive dataset, even though routing keys are hashed.

An erasure workflow must address raw events, extracted and manual records, snapshots and retained object versions, and Eve session/replay state. Coordinate replay retirement so old events or input cannot recreate erased facts and old snapshots cannot reintroduce erased text. `forget` deletes one scope-checked long-term record. It cannot erase original raw events, Eve history, current context, or old S3 text, and cannot stop extraction already in flight. Deleting only AgentCore records or clearing an Eve session is insufficient. There is no whole-user delete API, automatic GDPR purge, or compliance guarantee in this adapter.

Runtime record-deletion permission supports `forget`; it is not whole-resource teardown permission. Cleanup and full erasure require a separately reviewed administrator workflow. The [setup guide's destructive examples](setup.md#live-verification-and-cleanup) are only for dedicated disposable resources after the replay horizon, not a general privacy deletion procedure. No cleanup has run.

## IAM separates runtime from administration

[Runtime IAM template](iam.json) covers AgentCore `CreateEvent`, `ListMemoryRecords`, `RetrieveMemoryRecords`, `BatchCreateMemoryRecords`, `GetMemoryRecord`, and `DeleteMemoryRecord` on one memory ARN. The last three support explicit writes and ownership-checked deletion. S3 `GetObject` and `PutObject` apply only to the `eve-memory/v1/*` object prefix in one dedicated private bucket. `ListBucket` is unconditional but resource-specific to that one bucket. This allows listing the dedicated bucket's keys, not reading or writing objects outside the snapshot prefix or accessing other buckets.

A missing-key `GetObject` requires bucket list authorization to return `404` rather than `403`. A prefix-conditioned list grant is not used to authorize this GET behavior. The adapter treats `NoSuchKey` as absence and does not treat access denial as a miss. Verify a missing-object `GetObject` using the exact effective role and bucket policy before use; that effective-role check remains unverified. Do not mask a failure by swallowing `403`.

The live hook check additionally needs `bedrock-agentcore:ListEvents` and control-plane `bedrock-agentcore:GetMemory`, limited to the chosen memory ARN. `CreateMemory` belongs in a separate provisioning administrator policy with its own resource and condition review. Provisioning also needs `GetMemory` to wait for activation. If an execution role is supplied, review narrowly scoped `iam:PassRole` separately. Ordinary provider construction must not provision or delete resources.

Use the standard AWS SDK credential chain locally. In an application, explicitly supply approved runtime credential providers through both `clientConfig` and `snapshotClientConfig`, or inject both clients. An AgentCore client configuration does not configure S3. Vercel deployment must use an approved IAM role or federation arrangement; this project has no verified federation recipe. Never request credentials in chat.

## Script behavior and live gate

The scripts exist and match the commands declared in `package.json`. Read the help first. Run confirmed commands only after logging into the approved account and reviewing the region, dedicated memory, bucket, IAM, and costs:

```bash
pnpm create-memory --help
pnpm create-memory --confirm
pnpm live-smoke --help
pnpm live-smoke --confirm
```

Both AWS scripts handle `--help` without AWS calls and refuse mutations without `--confirm`. The confirmed commands create billable resources or write AWS data. No confirmed command has run here, and neither script performs automatic cleanup.

- `scripts/create-memory.ts` requires `AWS_REGION` and `AWS_SNAPSHOT_BUCKET`. It checks that the bucket variable is set, but does not inspect the bucket's existence, privacy, or retention. The bucket must already exist and be private. The script never creates a bucket or IAM role, defaults `AWS_MEMORY_NAME` to `EveAgentMemory`, uses `eventExpiryDuration: 7`, and accepts optional `AWS_MEMORY_EXECUTION_ROLE_ARN`. It waits up to five minutes for the memory and both strategies to become active, then prints `AWS_MEMORY_ID`. Inspect the printed resource before retrying after a failure.
- `scripts/live-smoke.ts` requires `AWS_REGION`, `AWS_MEMORY_ID`, and `AWS_SNAPSHOT_BUCKET`. It calls real provider hooks with synthetic Eve contexts, verifies active strategies and namespaces, captures synthetic text twice to check duplicate tokens, and polls extraction for up to five minutes within a seven-minute overall budget, allowing another 30 seconds each for explicit-record indexing and deletion visibility. It checks cross-session recall, another actor's isolation, replay after provider reconstruction, and concurrent snapshots. Explicit-tool checks write/delete synthetic records and exercise search, remember, and forget. Polling creates durable snapshots; retain them through the replay horizon. Deleting the tool's synthetic record does not clean up all events or snapshots.
- The hook smoke test does not start the full Eve runtime or invoke an application LLM. AgentCore extraction can still use model processing and incur AWS costs.
- `scripts/pack-smoke.mjs`, invoked by `pnpm pack-smoke` after `pnpm build`, packs and imports the artifact, checks named/default exports and provider hooks, and constructs the provider without AWS credentials. It reuses installed dependencies and does not prove a fresh consumer installation.

Bucket creation is a separate opt-in administrator action. The [private bucket setup guide](setup.md#dedicated-private-snapshot-bucket) includes region-specific `aws s3api create-bucket` commands and `put-public-access-block`. For `us-east-1`, omit `--create-bucket-configuration`; other regions use `LocationConstraint="$AWS_REGION"`. Review bucket policy and lifecycle rules separately, and prohibit expiration or deletion during the replay horizon. These billable setup commands have not run here. The [registry plan](registry.md) describes the separate npm publication, JSON hosting, and official acceptance requirements; the intended `eve add memory/agentcore` command is not available yet.

Record exact commands, account and region without secrets, pass/fail evidence, extraction timing, effective IAM results, and resource IDs needed for reviewed cleanup. Separately verify an authenticated Eve runtime session and any deployment. Do not turn a passing provider-hook test into a claim about production behavior.

## Comparison is about adapter responsibilities

[Eve's provider contract](https://eve.dev/docs/memory/custom-provider) defines recall, optional capture, and scope-bound tools. [Supermemory's Eve adapter](https://github.com/supermemoryai/eve-supermemory) is a reference for how a hosted service fits that contract. Eve's public [memory overview](https://eve.dev/docs/memory#supermemory) describes Supermemory's automatic capture and tools for search, remember, forget, and source extraction.

This prototype uses the same lifecycle boundary but delegates extraction and indexing to AgentCore. It adds S3 operation snapshots and scope-bound search, remember, and forget. It has no source or file-extraction pipeline. Sharing tool names does not imply Supermemory feature parity, matching retention semantics, equivalent erasure, matching search quality, or complete runtime verification.

## Authoritative references

Local implementation references are `src/index.ts`, `src/options.ts`, `src/provider.ts`, `src/lib/capture.ts`, `src/lib/recall.ts`, `src/lib/records.ts`, `src/lib/scope.ts`, `src/lib/snapshots.ts`, `src/lib/text.ts`, `src/tools/search.ts`, `src/tools/remember.ts`, `src/tools/forget.ts`, `src/tools/index.ts`, the tests, and `package.json`. Eve compatibility decisions use the installed `0.71.3` documentation before newer public examples. Registry metadata follows its bundled `docs/install-integrations.mdx`.

- [Eve memory overview](https://eve.dev/docs/memory), [custom provider contract](https://eve.dev/docs/memory/custom-provider), and [multi-tenant scoping](https://eve.dev/docs/patterns/multi-tenant-memory).
- [AgentCore Memory overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html).
- [Long-term extraction and retrieval](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/long-term-saving-and-retrieving-insights.html) and [namespace organization](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/specify-long-term-memory-organization.html).
- [CreateEvent](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_CreateEvent.html), [ListMemoryRecords](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_ListMemoryRecords.html), [RetrieveMemoryRecords](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_RetrieveMemoryRecords.html), and [ListEvents](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_ListEvents.html).
- [CreateMemory](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CreateMemory.html), [GetMemory](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_GetMemory.html), and [AgentCore IAM actions and memory ARNs](https://docs.aws.amazon.com/service-authorization/latest/reference/list_bedrock-agentcore.html).
- [AWS SDK for JavaScript credential providers](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html).
- [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html), [S3 consistency](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel), and [GetObject permission behavior](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).
- [Supermemory's Eve adapter](https://github.com/supermemoryai/eve-supermemory).
