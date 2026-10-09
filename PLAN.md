# Remember, forget, and simpler setup

Status: implemented and locally verified. This continues the existing adapter; AWS resource operations and npm publishing are outside this change.

## Summary

Complete the core model-facing memory operations with scope-bound `search`, `remember`, and `forget`. Use the Supermemory-style `src/`, `src/lib/`, and `src/tools/` layout, and shorten the README to purpose, Eve usage, AWS setup, and local development.

## Context and system impact

Eve owns authenticated scope, tool-call identity, lifecycle, and replay. AgentCore owns long-term records. S3 keeps immutable recall results for historical operations. The clean checkout currently exposes only search and automatic user-text capture.

Explicit records need a separate actor-scoped manual namespace so they do not depend on extraction strategies. New recall operations must include those records even without a search query. Historical recall snapshots stay unchanged after remember/forget so Eve replay remains deterministic.

Forget means deletion of one long-term record from future AWS retrieval. It does not erase raw events, current model context, or historical snapshots, and extraction of retained source text can recreate similar information. Complete source ingestion and whole-user erasure remain outside this change; this is core memory-operation parity, not every Supermemory capability.

## Approach

- Keep `src/index.ts`, `src/options.ts`, and `src/provider.ts` at the root. Move shared capture, recall, scope, text, and snapshots into `src/lib/`. Put tool implementations and their composition in `src/tools/`.
- Add `manualNamespace`, default `/eve/actors/{actorId}/manual/`, with the same scope/template validation and nonoverlap rules as facts/preferences.
- `remember({ content })` creates one explicit record using `BatchCreateMemoryRecords`, a scope-derived namespace, and a deterministic token based on resource, locked scope, session/turn, and Eve tool `callId`. Enforce the 16,000-byte text budget, require a valid successful result, and surface per-record failures even if HTTP succeeds. Return the record ID.
- `forget({ id })` fetches the record with a scope-bound namespace, verifies its ID and that every returned namespace belongs to the locked scope, then deletes using the verified namespace. Reject foreign records and propagate permissions/network failures. A missing record returns a bounded not-found result, not a false erasure claim.
- Include manual records in search and list them alongside preferences in ordinary and standalone-compaction recall. Keep byte budgets and historical snapshot replay intact.
- Skip automatic capture for current turns using remember/forget so explicit writes and deletion requests are not immediately re-ingested. Distinguish real user deliveries from Eve's user-role framework messages, including compaction continuations. Existing extraction can still create related records; do not claim full source erasure.
- Add IAM permissions for batch creation, record reads, and single-record deletion. Do not add broad event/S3 deletion privileges.
- Supply an installable shadcn-format registry item with an embedded memory-slot scaffold. Treat `eve add memory/agentcore` as the intended official-registry command after npm publication and registry acceptance, not as currently available. No publishing pipeline or external registry contribution is included.
- Shorten `README.md` to four sections. Move detailed retention, security, options, bucket setup, cleanup, and registry-registration notes into `docs/`. Keep a short deletion caveat and honest prepublication instructions in the README.

## Files

- `src/lib/`: existing helper moves and shared namespace/record handling.
- `src/tools/search.ts`, `remember.ts`, `forget.ts`, `index.ts`: three scope-bound tools.
- `src/options.ts`, `src/provider.ts`: manual namespace and tool composition.
- `tests/tools.test.ts`, existing lifecycle tests, `tests/sdk.test.ts`: mutations, replay, isolation, schema limits, and actual SDK serialization without network calls.
- `scripts/live-smoke.ts`: opt-in explicit-write/delete checks in addition to existing lifecycle checks.
- `README.md`, `docs/`, `examples/agent/instructions.md`: concise setup plus accurate deeper guidance.
- `registry/`, `registry.json`, registry validation test: registration-ready item and lazy Eve slot scaffold.
- `tsconfig.json`, `tsconfig.build.json`, `scripts/pack-smoke.mjs`: compile/pack checks for the requested layout and registry scaffold where needed.

## Verification

1. Prove the layout move with the existing suite and typecheck before adding behavior.
2. Test remember success, partial/empty batch responses, limits, cancellation, stable tokens across replay, and different scopes/call IDs.
3. Test forget scope verification, prefix collisions, mixed namespaces, missing records, failures, and cancellation before deletion.
4. Test explicit record visibility in new recall/search and absence after delete, while historical snapshots remain unchanged.
5. Check real SDK serialization for creation/get/deletion without AWS requests.
6. Validate registry payload and the slot scaffold; use the installed Eve registry reader and a temporary local HTTP server, without installing an unpublished npm dependency or provisioning AWS.
7. Run focused tests, then typecheck, full tests, build, packaged import, script help, and IAM JSON checks.

Live AWS and full Eve-runtime behavior remain unverified until credentials and dedicated resources are approved. Continue the project's requested Git commit/push workflow after local verification. Do not publish to npm, create a publishing pipeline, or mutate AWS resources.
