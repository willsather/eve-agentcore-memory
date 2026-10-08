# Eve AgentCore Memory adapter

Status: implemented; local verification and publication in progress. Live AWS and full Eve-runtime verification remain separate gates.

## Summary

Build a standalone TypeScript ESM package for Amazon Bedrock AgentCore Memory. Eve owns agent execution and sessions. AWS owns event ingestion and long-term fact/preference extraction. A private S3 bucket stores canonical recall results so Eve can replay operations without re-querying changing memory.

The first version includes automatic new-user-text capture, lifecycle recall, and a scope-bound search tool. It does not require AgentCore Runtime or implement remember/forget, source extraction, or complete erasure.

## Design decisions

- Use Eve `0.71.3` as the tested development dependency, based on its bundled memory contract and the Supermemory adapter's development baseline.
- Hash Eve's locked scope key into an AWS-safe actor ID. Scope every retrieval within the query, with trailing-slash namespace prefixes.
- Capture `turn.input` user text only. Do not ingest assembled history, recalled memories, tool output, assistant claims, or system prompts.
- Extract semantic facts and user preferences using `/eve/actors/{actorId}/facts/` and `/eve/actors/{actorId}/preferences/`.
- Bound messages, queries, records, and JSON tool output by UTF-8 bytes; propagate cancellation and failures.
- Return one stable-ID recall context, including an explicit absence message to replace stale context.
- Use S3 `IfNoneMatch: "*"` and read the stored winner after a write or a competing writer's `412`. Reject corrupt, oversized, mismatched, or inaccessible snapshots. Do not truncate historical results during replay.
- Keep snapshots available for the entire replay horizon. Do not use expiring AgentCore events for snapshots. Review found their finite retention insufficient for unbounded replay, so the initial event-snapshot proposal was replaced with S3 conditional writes.
- Resolve resource IDs and credentials at runtime, not during Eve discovery/build. Never provision in provider construction.
- Scripts require explicit `--confirm` before AWS mutations. They neither create a bucket nor delete resources automatically.

## Files

- `src/options.ts`, `src/index.ts`: public factory configuration and exports.
- `src/provider.ts`: Eve lifecycle hooks and scope-bound search.
- `src/scope.ts`, `src/text.ts`: storage identifiers and UTF-8 text handling.
- `src/capture.ts`: new-user-message selection, bounded batches, deterministic client tokens.
- `src/recall.ts`: scoped retrieval, pagination, budgets, and stable-ID context.
- `src/snapshots.ts`: private S3 canonical snapshots and conditional-write arbitration.
- `tests/`: deterministic mock-backed lifecycle tests and real SDK serialization checks without network access.
- `scripts/create-memory.ts`, `scripts/live-smoke.ts`: opt-in AWS setup and hook-level integration checks.
- `scripts/pack-smoke.mjs`: packed ESM import and lazy factory check.
- `examples/agent/`: consuming memory slot and memory safety instructions.
- `README.md`, `docs/research.md`, `docs/iam.json`: setup, research, permissions, limitations, consent, retention, and reviewed cleanup.
- `.github/workflows/ci.yml`: Node 24 CI without AWS credentials or live model calls.

## Verification

Local gates are `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm pack-smoke`, both script `--help` commands, and IAM JSON validation. Compile the consuming slot against the real Eve peer types.

Tests cover scope isolation, prefix collisions, mixed content, UTF-8 size bounds, payload batching, deterministic tokens, mock capture deduplication, pagination, cancellation, corrupt snapshots, changed replay budgets, concurrent conditional writes, and interrupted writes. SDK transport tests verify actual serialized request shapes without AWS calls.

After local login and account/region approval, run the live hook smoke test on dedicated resources. Check strategy activation, asynchronous preference extraction, cross-session recall, actor isolation, capture deduplication, restart replay, and concurrent snapshots. Then separately verify authenticated sessions in a full Eve application and any deployment. Hook contexts and mocked clients do not prove full runtime behavior.

## Publication

Create the public personal repository `willsather/eve-agentcore-memory`, commit verified source and documentation, and push `main`. Do not publish to npm, create AWS resources, or delete cloud data as part of this step.

## Sources

See [docs/research.md](docs/research.md) for AWS, Eve, Supermemory, S3 consistency, and conditional-write references.
