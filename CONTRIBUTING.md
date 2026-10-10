# Contributing to gameye-mcp

Thanks for helping improve the Gameye MCP server.

## Setup

You need Node.js 22 or newer, for development and to run the published package. CI tests on Node 22 and 24.

```bash
git clone https://github.com/gameye/gameye-mcp.git
cd gameye-mcp
npm ci
```

## Checks

Run all of these before you open a pull request. CI runs the same ones.

```bash
npm test                                # unit tests (vitest)
npx tsc --noEmit -p tsconfig.test.json  # typecheck source and tests
npm run build                           # compile to dist/
npm run test:smoke                      # drive the built server over stdio (after build)
npm pack --dry-run                      # inspect the files that would be published
```

The unit tests mock HTTP and never call a real Gameye API. If you test against a live API, use a sandbox token with the fewest scopes the task needs, and keep it out of commits, logs and issue text.

## Pull requests

- Keep each pull request focused on one change, and explain what it changes and why.
- Add or update tests for any behaviour you change.
- Update `README.md` when you add or change a tool, an environment variable or a required scope.
- Don't commit secrets, `.env` files or build output (`dist/`).
- CI must pass before a pull request can be merged.

## Releasing

Releases are cut by maintainers from a version tag on `main`; npm publishing needs no token.

1. Bump `version` in `package.json` (and `package-lock.json`) and add a `CHANGELOG.md` entry, in a pull request.
2. After it merges, tag the merge commit `vX.Y.Z` (or `vX.Y.Z-beta.N` for a prerelease) and push the tag.
3. The `Release` workflow checks the tag is on `main` and matches `package.json`, runs the same checks as CI (tests on Node 22 and 24, typecheck, build, the internal-reference scan and a full-history gitleaks secret scan) plus the stdio smoke test on the packed tarball, and packs the tarball.
4. A maintainer approves the run in the `release` environment. It then publishes that exact tarball to npm through trusted publishing (GitHub OIDC), with provenance. Prereleases go to the `beta` dist-tag, so `npx -y gameye-mcp` keeps installing the latest stable version.

Version 0.1.0 was published by hand, because npm trusted publishing cannot create a new package; every later version goes through the workflow.

## Reporting issues

Report bugs and feature requests in [GitHub issues](https://github.com/gameye/gameye-mcp/issues). Report security issues privately, as described in [SECURITY.md](SECURITY.md).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE), and that you will follow our [Code of Conduct](CODE_OF_CONDUCT.md).
