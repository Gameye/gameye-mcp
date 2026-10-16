# Changelog

All notable changes to `gameye-mcp` are listed here. The project follows [semantic versioning](https://semver.org); until 1.0, a minor release may change tools, inputs or outputs.

## Unreleased

- `manifest.json` and `.mcpbignore` build an MCPB bundle (`npx @anthropic-ai/mcpb pack`) for Smithery and one-click Claude Desktop installs. A unit test keeps its version and tool list in step with the package.
- `glama.json` names the maintainers so the Glama directory listing can be claimed.
- No changes to the server.

## 0.3.1

- README: Windows notes (start the server through `cmd /c npx` in most Windows MCP clients, type `npx.cmd` in PowerShell, first-start time, how `gameye_update_skills` and `gameye_create_token` behave on Windows). Tested on Windows 11 with Node.js 22 and Claude Code.
- CI runs the unit tests, build and stdio smoke test on Windows.
- No changes to the server.

## 0.3.0

- The release workflow skips `npm publish` when npm already holds this version with the same tarball, and waits up to 15 minutes for npm to show a new version. A release whose npm check timed out can now be finished by re-running its failed jobs.
- New `gameye_update_skills`: compares the installed Gameye skills (skills CLI, user-wide or project, and the Claude Code plugin) with the latest pack on GitHub, and with `apply: true` updates them through the skills CLI or `claude plugin update`. It only touches skills installed from `gameye/gameye-skills`.

## 0.2.0

- Published to npm only. The release workflow timed out waiting for npm to show the version, so the container image and the MCP Registry entry stayed at 0.1.3. 0.3.0 ships all three.
- `gameye_create_application`, `gameye_edit_application` and `gameye_create_token` are always registered, so an agent can set up a deployment end to end. `GAMEYE_ENABLE_ADMIN_TOOLS` is removed and ignored if set. The token's scopes (`application:write`, `token:write`) decide what the agent can change.
- `gameye_context` no longer reports an admin-tools line.

## 0.1.3

- Listed in the official MCP Registry as `io.github.Gameye/gameye-mcp`. The registry name is case-sensitive and must match the GitHub owner, so `mcpName` and the image's `io.modelcontextprotocol.server.name` label change from `io.github.gameye/…` to `io.github.Gameye/…`.
- No changes to the server.

## 0.1.2

- Container image: `docker run -i --rm -e GAMEYE_API_TOKEN ghcr.io/gameye/gameye-mcp` runs the server without Node.js, on amd64 and arm64. Published by the Release workflow with provenance and an SBOM.
- No changes to the server.

## 0.1.1

First release published by the Release workflow through npm trusted publishing, with provenance. No changes to the server.

## 0.1.0

First public release, in beta.

- MCP server over stdio for the Gameye session API, on the sandbox (default) or production host (`GAMEYE_ENV`).
- Session tools: launch, list, describe and stop sessions; join and leave players; fetch logs and artifacts.
- Image and placement tools: list applications and registry tags, check and enable a tag, list regions and available locations.
- `gameye_context` explains the environment, scopes and beta status to the agent.
- Admin tools (create or edit applications, create tokens) only when `GAMEYE_ENABLE_ADMIN_TOOLS=1`.
- Needs Node.js 22 or newer.
