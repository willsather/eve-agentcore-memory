# Eve registration plan

The intended official install is `eve add memory/agentcore` after npm publication and acceptance into Eve's registry. Neither has happened yet. Use the [local tarball and slot instructions](../README.md#how-to-use-it-with-eve) today.

## Local registry files

The registration files follow the installed Eve `0.71.3` guide at `node_modules/eve/docs/install-integrations.mdx`:

| Path | Purpose |
| --- | --- |
| `registry.json` | Catalog metadata using the shadcn registry schema. |
| `registry/memory/agentcore.ts` | Consumer slot source, installed at `agent/memory/agentcore.ts`. |
| `registry/memory/agentcore.json` | Installable item with embedded source content. |

Use `registry:item` for the item and `registry:file` for its file, with an explicit consumer target. `files[].path` is relative to the catalog; `files[].target` is relative to the consuming Eve project. The item declares `dependencies: ["eve-agentcore-memory"]` and documents `AWS_REGION`, `AWS_MEMORY_ID`, and `AWS_SNAPSHOT_BUCKET`.

The consumer slot imports the package factory, uses `byPrincipal`, and resolves memory ID and bucket lazily. Configure both AWS client regions explicitly. Set `capture: false` until the application configures consent and redaction. Installation must not provision AWS resources. Consumers still follow the [AWS setup guide](setup.md).

## Publication and acceptance

1. Publish the npm package after the separate release review. The registry dependency must resolve before consumer installation can work.
2. Push the catalog, consumer source, and embedded item JSON. The local files are not evidence of available public endpoints.
3. Check hosted catalog and item responses from a separate Eve project, inspect the generated slot, and review the dependency installation. The embedded item is tested with Eve's installed registry reader over local HTTP, and the scaffold is typechecked; hosted dependency installation has not run.
4. Obtain Eve maintainer agreement through an issue, then submit the integration following Eve's registry contribution guide. Official acceptance is required for the unprefixed `memory/agentcore` command.

A third-party registry can serve JSON over HTTP without a publishing pipeline. Once the files are pushed and npm publication is complete, a public raw GitHub item URL could support direct installation:

```bash
# future example only, unavailable until the publication steps above are complete
eve add https://raw.githubusercontent.com/willsather/eve-agentcore-memory/main/registry/memory/agentcore.json
```

For catalog listing and search, serve the catalog as well as item endpoints using the URL layout expected by Eve. A direct item URL does not imply official registration. No hosting scripts, deployment pipeline, or automated AWS setup are part of this plan.

## References

- [Eve integration installation](https://eve.dev/docs/install-integrations).
- [Eve registry contribution guide](https://github.com/vercel/eve/blob/main/CONTRIBUTING.md#adding-an-integration-to-the-registry).
- [shadcn registry format](https://ui.shadcn.com/docs/registry).
