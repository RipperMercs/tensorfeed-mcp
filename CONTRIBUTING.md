# Contributing

Thanks for the interest in `@tensorfeed/mcp-server`. This guide covers how to file an issue, what kinds of changes are welcome, and how releases happen.

## Filing issues

- Bug reports: include the version, the tool you called, the input, and the response. Stack traces are gold.
- Feature requests: explain the use case first, then the proposed shape. New tools should expose useful TensorFeed data; UI surfaces belong on the website, not in the MCP server.
- Security reports: do NOT file a public issue. See SECURITY.md (or email `security@tensorfeed.ai`) for the private-disclosure flow.

## Pull requests

- One concern per PR. A small, well-scoped change merges faster than a large refactor.
- Free tier vs premium tier: changes that touch a paid endpoint must keep the AFTA guarantees intact (no-charge on 5xx, breaker, schema fail, stale data). Look at how existing premium tools handle these.
- Keep transport boundaries clean. The MCP server is the boundary; downstream tooling should not call the TensorFeed REST API directly from the MCP code path when the data is already cached.
- Run `npm test` locally before opening the PR.

## Code style

- TypeScript strict mode.
- Comments explain *why*, not *what*. The code should read on its own.

## Releases

Versioning follows semver:

- Patch: bug fixes, no schema changes
- Minor: new tools, new optional inputs, no breaking changes
- Major: anything that changes existing tool inputs or outputs

The publish flow is documented in `mcp-server/README.md` of the main TensorFeed monorepo.

## Maintainer

This package is maintained by [TensorFeed.ai](https://tensorfeed.ai). Email: `security@tensorfeed.ai` for security, `evan@tensorfeed.ai` for everything else.
