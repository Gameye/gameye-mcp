# Changelog

All notable changes to `gameye-mcp` are listed here. The project follows [semantic versioning](https://semver.org); until 1.0, a minor release may change tools, inputs or outputs.

## 0.5.3

- Every tool now sets all four MCP hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) to explicit values. Twelve tools left `destructiveHint` and/or `idempotentHint` unset; read-only tools now declare `destructiveHint: false` and `idempotentHint: true`, and `gameye_player_join` and `gameye_player_leave` declare `idempotentHint: false`. Some MCP directories reject a tool that omits any hint. The tool definition type now requires all four, so a new tool can't omit one. No tool behaviour changed.
- `manifest.json` lists Gameye's privacy policy (`privacy_policies`), and the README has a Privacy section.

## 0.5.2

- Raised the minimum runtime dependency versions so a fresh install can't resolve a release with a known advisory: `zod` to `^4.6.7` (GHSA-mrhx-c7xc-m3w5, memory exhaustion on oversized constrained collections, fixed in 4.6.6) and `@modelcontextprotocol/sdk` to `^1.32.2`. No tool, input or output changed. `npm audit` reports no vulnerabilities.

## 0.5.1

- Bundled skills pinned to gameye-skills `v1.7.1` (pack 1.7.1). No skill text changed; the bundled skill and template tools now report pack 1.7.1.

## 0.5.0

- No-token mode: the server starts without `GAMEYE_API_TOKEN`, prints one line on stderr saying so, and registers the same tools. **Behaviour change:** the server no longer exits when `GAMEYE_API_TOKEN` is unset; an invalid `GAMEYE_ENV` or other configuration error still stops it. A token setting left as an unexpanded `${user_config.api_token}` placeholder counts as no token.
- With no token, every account tool, `dryRun` calls included, sends nothing and returns an error that starts with `Token required:`, followed by where to get a token (trial.gameye.com, then Users → API tokens in the Admin Panel), the narrowest scope recipe for that tool, how to set the token for each install path, the restart rule, and the tools that work now. Only `gameye_context`, `gameye_update_skills`, `gameye_list_skills`, `gameye_get_skill` and `gameye_check_dockerfile` work without a token; a new tool needs one unless it opts out.
- Tool results show `· no token` after the host when no token is configured, and `gameye_context` reports `Token: configured` or `Token: not configured`, never any part of the token.
- New `gameye_list_skills` and `gameye_get_skill` serve a pinned copy of the Gameye skills (gameye-skills `v1.7.0`, named in `skills.pin`) bundled with the server, offline. `npm run sync-skills` regenerates it and `npm run check-skills` fails CI on drift.
- New `gameye_get_template` returns the Dockerfile or shutdown-hook template for an Unreal, Unity, Godot or web server, taken byte for byte from the bundled skill (gameye-skills v1.7.0, which also fixes Godot shutdown handling).
- New `gameye_check_dockerfile` checks Dockerfile text against the gameye-containerize container contract, offline: amd64 base, `EXPOSE`d ports, exec-form launch without `npm start`, no loopback bind, a non-root user, and no API token or credential in `ENV`/`ARG` (flagged values are redacted).
- The instructions sent to connecting clients depend on the token: with none, they open by naming the tools that work and the skill to read first; with one, they add a line naming the bundled skill tools to the beta notice. Each tool description says whether it works without a token.
- `manifest.json` (`api_token`) and `server.json` (`GAMEYE_API_TOKEN`, npm and OCI packages) mark the token optional.

## 0.4.0

- Session limits, enforced by the server before a launch is sent. By default: at most 5 sessions launched by this server running at once (`GAMEYE_MAX_SESSIONS`), a TTL of at most `4h` (`GAMEYE_MAX_TTL`), and 20 launches per server run (`GAMEYE_MAX_LAUNCHES`). A refusal says which limit applied. If the server can't list its sessions to check, the launch is refused. **Behaviour change:** a launch with a `ttl` above `4h`, or `ttl: "0"`, is now refused unless `GAMEYE_MAX_TTL` is raised.
- `GAMEYE_STOP_OWN_ONLY=1` makes `gameye_stop_session` refuse sessions this server did not launch. Off by default.
- `gameye_context` lists the limits in force.

## 0.3.2

- `gameye_update_skills` runs updaters only when the operator sets `GAMEYE_ENABLE_SKILLS_UPDATE=1`. Without it, `apply: true` lists the commands for the user to run, as on Windows. Checking is unchanged.
- The updater's child process gets an allowlisted environment (paths, home, temp, locale, proxy and CA settings, npm and Claude config). `GAMEYE_*` variables and anything named like a token, secret, password or key are never passed, so the Gameye API token stays in the server.
- The skills CLI is pinned: `npx -y skills@1.7.4 update …` instead of whatever version is newest.
- `@modelcontextprotocol/sdk` raised to `^1.32.1` and transitive dependencies updated: `npm audit` reports no advisories (it reported 10 before; none were reachable over the stdio transport the server uses).
- CI fails on high or critical advisories in runtime dependencies, its actions are pinned by commit, and Dependabot proposes npm and Actions updates weekly.
- `manifest.json` and `.mcpbignore` build an MCPB bundle (`npx @anthropic-ai/mcpb pack`) for Smithery and one-click Claude Desktop installs. A unit test keeps its version and tool list in step with the package.
- `glama.json` names the maintainers so the Glama directory listing can be claimed.

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
