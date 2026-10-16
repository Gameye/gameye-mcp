# Gameye MCP Server

[![Discord](https://img.shields.io/badge/Discord-join%20chat-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/QvJ3KH5max)

A [Model Context Protocol](https://modelcontextprotocol.io) server for the [Gameye](https://gameye.com) game server orchestration API. It lets an AI agent (Claude Code, Claude Desktop, Cursor, or any MCP client) launch and inspect game server sessions, check image tags and regions, and fetch logs and artifacts. You talk to it in plain language, and you don't have to leave your editor.

> **Status: beta** (`0.x`). Tools, inputs and outputs may change between releases, and there may be bugs. The server says so to every client that connects, on startup, and in `gameye_context`. It is published on npm as [`gameye-mcp`](https://www.npmjs.com/package/gameye-mcp), as a container image at `ghcr.io/gameye/gameye-mcp`, and in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.Gameye/gameye-mcp`; see the [changelog](https://github.com/Gameye/gameye-mcp/blob/main/CHANGELOG.md) for what changed in each release.

## Quick start

```bash
GAMEYE_API_TOKEN=<your-token> npx -y gameye-mcp
```

It needs Node.js 22 or newer. The server speaks MCP over stdio. Normally your MCP client starts it for you (see [Install](#install)), so you rarely need to run it by hand.

## Environments

Gameye has two public API hosts. The server targets **sandbox** by default.

| `GAMEYE_ENV` | Host | Who it is for |
|---|---|---|
| `sandbox` (default) | `https://api.sandbox-gameye.gameye.net` | Self-serve customers. This is your permanent home and runs live matches, not just tests. |
| `production` | `https://api.production-gameye.gameye.net` | Enterprise customers. |

The environment is a property of the server process. No tool takes an environment argument, so an agent can't switch to production partway through a conversation. If you need both, configure two named server entries (for example `gameye-sandbox` and `gameye-production`), each with its own token.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GAMEYE_API_TOKEN` | **Yes** | — | Gameye API token. Use the least-privileged scopes you need (see below). |
| `GAMEYE_ENV` | No | `sandbox` | `sandbox` or `production`. Selects the API host. |
| `GAMEYE_API_URL` | No | — | Overrides the host, for testing only. Must be `https`. If it equals one of the two known hosts, it must match `GAMEYE_ENV` or the server refuses to start. Any other URL is labelled `custom` in every tool result. |
| `GAMEYE_TIMEOUT_MS` | No | `30000` | Per-request timeout in milliseconds, a positive whole number. Log snapshots get at least 60 s and artifact downloads at least 120 s. A request that runs out of time comes back as a tool error: `Request to <host> timed out after <n>s`. |

## Install

### Claude Code

```bash
claude mcp add gameye --env GAMEYE_API_TOKEN=<your-token> -- npx -y gameye-mcp
```

For production, add `--env GAMEYE_ENV=production` and use a production token.

### Other MCP clients

Most clients (Claude Desktop, Cursor, Windsurf and others) accept an `mcpServers` block:

```json
{
  "mcpServers": {
    "gameye": {
      "command": "npx",
      "args": ["-y", "gameye-mcp"],
      "env": {
        "GAMEYE_API_TOKEN": "<your-token>",
        "GAMEYE_ENV": "sandbox"
      }
    }
  }
}
```

Restart the client after you change its configuration.

`npx -y gameye-mcp` runs the latest release. To stay on one version, name it: `npx -y gameye-mcp@0.3.1` (or `"args": ["-y", "gameye-mcp@0.3.1"]`).

### Windows

The server runs on Windows with Node.js 22 or newer. We've tested it on Windows 11, through Claude Code and over plain stdio. If something breaks on Windows, please [open an issue](https://github.com/Gameye/gameye-mcp/issues).

- Many Windows MCP clients can't start `npx` directly, because it's a `.cmd` script. Start it through `cmd /c` instead:

  ```json
  "command": "cmd",
  "args": ["/c", "npx", "-y", "gameye-mcp"]
  ```

  With Claude Code: `claude mcp add gameye --env GAMEYE_API_TOKEN=<your-token> -- cmd /c npx -y gameye-mcp`. Claude Code 2.1.296 and later also start plain `npx`.
- In PowerShell, type `npx.cmd` instead of `npx` when you run the server by hand. A new Windows install blocks the `npx` PowerShell script with "running scripts is disabled on this system".
- The first start downloads the package and can take 10 to 40 seconds. Later starts take about a second.
- `gameye_update_skills` reports outdated skills on Windows but doesn't run the update. It prints the commands for you to run.
- `gameye_create_token` writes the token file with owner-only permissions on macOS and Linux. On Windows those permissions don't apply, and the file gets the access rules of its folder. Write it inside your user profile.

### Docker

No Node.js on the machine? Run the published image instead. It works on amd64 and arm64:

```json
{
  "mcpServers": {
    "gameye": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "GAMEYE_API_TOKEN", "-e", "GAMEYE_ENV", "ghcr.io/gameye/gameye-mcp"],
      "env": {
        "GAMEYE_API_TOKEN": "<your-token>",
        "GAMEYE_ENV": "sandbox"
      }
    }
  }
}
```

With Claude Code: `claude mcp add gameye --env GAMEYE_API_TOKEN=<your-token> -- docker run -i --rm -e GAMEYE_API_TOKEN ghcr.io/gameye/gameye-mcp`.

- Pass each variable with `-e NAME` (no value), so Docker copies it from the client's environment and the token never appears in the command line.
- Keep `-i` and never add `-t`: a terminal mangles the JSON-RPC messages on stdout.
- To stay on one version, use a version tag such as `ghcr.io/gameye/gameye-mcp:0.3.1`.
- Files the server writes stay inside the container, and `--rm` deletes them:
  - `gameye_get_artifacts` saves its download under the temp directory. To keep it, mount a directory and point the temp directory at it: `-v /absolute/dir:/out -e TMPDIR=/out`. The path the tool reports is the container path; the file is in `/absolute/dir` on the host.
  - `gameye_create_token` writes to the `outputPath` you give it. Mount a directory the same way and pass an `outputPath` under `/out`.
  - The server runs as uid 1000, so on Linux the mounted directory must be writable by that user.

## Token scopes

Give the server a token with only the scopes it needs.

| Recipe | Scopes | What the agent can do |
|---|---|---|
| Observer | `session:read` `logs:read` `artifact:read` `regions:read` `region:read` `application:read` | Inspect sessions, logs, artifacts, regions and applications. No changes. |
| Operator | Observer + `session:start` `session:stop` `session:write` | Also launch and stop sessions and update session state. |
| Deployer | Operator + `application:write` | Also create and edit applications, so the agent can set up a deployment end to end. |
| Token admin | Deployer + `token:write` | Also create API tokens. |

**Never pass your Gameye API token into a game server's environment.** A game server doesn't need it, and anything inside the container can read it.

## Available tools

Every tool result starts with the environment and host it used, for example `[sandbox · api.sandbox-gameye.gameye.net]`.

| Tool | Kind | Description |
|---|---|---|
| `gameye_context` | read | Show the environment, host and server version this server targets, and the guardrail defaults (session TTL, `launched-by` label, token expiry) |
| `gameye_launch_session` | write, `dryRun` | Start a containerized game server (billable). Default TTL and agent label applied; see [Guardrails](#guardrails) |
| `gameye_list_sessions` | read | List running sessions (filterable; `all=true` for every status) |
| `gameye_describe_session` | read | Get session details, ports and players |
| `gameye_stop_session` | destructive, `dryRun` | Stop one session by its exact ID |
| `gameye_player_join` | write | Register one or more players as joined |
| `gameye_player_leave` | write | Remove one or more players from a session |
| `gameye_get_locations` | read | List locations that can host an image right now |
| `gameye_list_regions` | read | List the regions available to your organization |
| `gameye_check_tag` | read | Check whether an image tag is available in a region |
| `gameye_list_applications` | read | List your applications with registry, resources, regions and ports |
| `gameye_list_registry_tags` | read | List an application's tags in its upstream registry (paged) |
| `gameye_enable_tag` | write, `dryRun` | Enable an image tag for an application so Gameye preloads it |
| `gameye_get_logs` | read | Fetch session logs |
| `gameye_get_artifacts` | read | Download a file or directory from a session container as a tar archive |
| `gameye_create_application` | write, `dryRun` | Create an application |
| `gameye_edit_application` | destructive, `dryRun` | Change an application; omitted fields stay unchanged |
| `gameye_create_token` | write, `dryRun` | Create an API token and write it to a file |
| `gameye_update_skills` | read, or write with `apply` | Compare the installed [Gameye skills](https://github.com/gameye/gameye-skills) with the latest pack, and update them with `apply: true`. See [Keeping the skills current](#keeping-the-skills-current) |

Every tool carries MCP annotations: read tools set `readOnlyHint`, `gameye_stop_session` and `gameye_edit_application` set `destructiveHint`, and every tool that calls the Gameye API sets `openWorldHint`.

The tool set covers every operation in the Gameye client API. `tests/parity.test.ts` checks this against the vendored spec in `spec/`.

## Guardrails

These behave the same on sandbox and production, because sandbox runs live matches for self-serve customers.

- **Dry run.** `gameye_launch_session`, `gameye_stop_session`, `gameye_enable_tag` and the application and token tools accept `dryRun: true`. The tool returns the exact request (method, host, path and body) with the API token masked, and sends nothing.
- **Bounded sessions.** A launch without `ttl` gets a `30m` TTL, and the result says the default was applied. Every launch sends the label `launched-by: gameye-mcp`, replacing any `launched-by` value the caller passes, so agent-launched sessions can be found with `gameye_list_sessions` and `filter: { "launched-by": "gameye-mcp" }`. When a warm pool serves the image and region, the Gameye API ignores request labels (and env and args), so warm-pool sessions do not carry this label.
- **No token in game servers.** A launch is refused, with nothing sent, if any env value or name, arg, or label key or value contains this server's Gameye API token. Env values are never shown in results.
- **No token in results.** Every tool result, including errors, has this server's API token replaced with `***`, in case log output, labels or an error message echo it.
- **Explicit stops.** `gameye_stop_session` stops exactly one session by its exact ID. There is no bulk stop, and empty, wildcard or list IDs are refused.

## Keeping the skills current

The [Gameye skills](https://github.com/gameye/gameye-skills) change as the Gameye API does. `gameye_update_skills` reads the latest pack version from the `gameye` skill on GitHub (`Pack version:` in `skills/gameye/SKILL.md` on `main`) and compares it with what is installed:

- **skills CLI, user-wide:** skills recorded in `~/.agents/.skill-lock.json` with source `gameye/gameye-skills`.
- **skills CLI, this project:** the same, in `skills-lock.json` in the server's working directory.
- **Claude Code plugin:** `gameye@gameye` in `~/.claude/plugins/installed_plugins.json`.

Without `apply` it only reports. With `apply: true` it runs each outdated install's own updater: `npx -y skills update <the Gameye skills> -g -y` (or `-p -y`), or `claude plugin marketplace update gameye` then `claude plugin update gameye@gameye`. It only updates skills whose lock-file source is `gameye/gameye-skills`, and it never downloads or follows skill text itself. Each command runs with stdin closed and a 90-second limit. On Windows it prints the commands instead of running them. The running agent session keeps the skills it loaded; the next session uses the update. The `gameye` skill tells agents to run the check once per conversation and ask before applying.

## Telemetry/attribution

Every request to the Gameye API sends `User-Agent: gameye-mcp/<version>`, plus the MCP client's name once it has connected, e.g. `gameye-mcp/0.1.0 (claude-code)`, so Gameye can count MCP usage. Only this server's version and the client name are sent, nothing else: no token, env values, paths or other data. There is no other telemetry.

## Application and token tools

`gameye_create_application`, `gameye_edit_application` and `gameye_create_token` are always registered. What the agent can actually do is set by the token's scopes: they need `application:write` or `token:write`, and a token without them gets a 403 naming the missing scope. To keep an agent from changing applications or minting tokens, give it a token without those scopes.

`gameye_create_token` never returns the new token. It writes the token to the file you name in `outputPath` and returns only the path, the scopes and the expiry:

- `outputPath` must be an absolute path outside any git working tree, so the token can't be committed by accident.
- An existing file is refused unless you pass `overwrite: true`. A symlink is always refused.
- The file is created exclusively with `0600` permissions and without following symlinks. The file is reserved before the token is minted, so a bad path never creates a token.
- `expires_after` defaults to `24h`. Requested scopes must be a subset of the server token's own scopes.
- If the file can't be written after the token was minted (for example, the disk is full), no partial file is left behind and the tool returns an error naming the token, saying it was created but the secret is lost, so you can revoke it.

`gameye_edit_application` sends only the fields you give. `regions` and `ports`, when given, replace the whole list.

### TLS ports

A port with `tls: true` has TLS terminated by Gameye on the host. Set it with `gameye_create_application`: `gameye_edit_application` doesn't apply `tls`, and any `ports` sent through edit are stored with `tls=false`, so omit `ports` when editing an application that uses TLS.

## Agent skills

To teach your agent how to integrate Gameye (session lifecycle, matchmaking, webhooks and more), install the sister project [gameye-skills](https://github.com/gameye/gameye-skills). The skills use these MCP tools when they are available, and fall back to plain HTTP when they aren't.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm ci
npm test
npx tsc --noEmit -p tsconfig.test.json
npm run build
```

`spec/client.yaml` is a snapshot of the public sandbox `/openapi.yaml`, and `spec/overrides.yaml` holds the MCP tool name for each operation: the `tools:` map from [gameye-skills](https://github.com/gameye/gameye-skills)' `spec/overrides.yaml`, reduced by `scripts/reduce-overrides.mjs` (gameye-skills keeps the full file, which records where the server differs from the spec). Refresh both with `npm run sync-spec [path-or-url-to-overrides.yaml]`. `npm run check-spec` exits 1 when either snapshot has drifted.

## About Gameye

[Gameye](https://gameye.com/?utm_source=github&utm_medium=readme&utm_campaign=gameye-mcp) is a managed hosting platform for multiplayer game servers. You bring a container image, and Gameye starts a dedicated server for each match through one API.

- Session API docs: [gameye.com/docs/api-v2](https://gameye.com/docs/api-v2/?utm_source=github&utm_medium=readme&utm_campaign=gameye-mcp)
- Gameye docs: [gameye.com/docs](https://gameye.com/docs/?utm_source=github&utm_medium=readme&utm_campaign=gameye-mcp)
- Try it free: [trial.gameye.com](https://trial.gameye.com/?utm_source=github&utm_medium=readme&utm_campaign=gameye-mcp)

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Gameye B.V.
