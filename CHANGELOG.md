# Changelog

All notable changes to `gameye-mcp` are listed here. The project follows [semantic versioning](https://semver.org); until 1.0, a minor release may change tools, inputs or outputs.

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
