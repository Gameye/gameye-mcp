#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GameyeClient } from "./client.js";
import { loadConfigOrExit } from "./env.js";
import type { ServerContext } from "./tools/common.js";
import { registerAllTools } from "./tools/register.js";
import { createServer } from "./server.js";
import { BETA_NOTICE } from "./beta.js";
import { VERSION as version } from "./version.js";

const config = loadConfigOrExit(process.env);

const client = new GameyeClient({ token: config.token, baseUrl: config.baseUrl, timeoutMs: config.timeoutMs });

const ctx: ServerContext = {
  environment: config.environment,
  host: config.host,
  baseUrl: config.baseUrl,
  version,
  mask: (text) => client.maskToken(text),
};

const server = createServer(version);

registerAllTools(server, client, ctx);

// Attribute API traffic to the MCP client (name only) once it has introduced itself.
server.server.oninitialized = () => client.setClientName(server.server.getClientVersion()?.name);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(
  `Gameye MCP server ${version} running on stdio [${ctx.environment} · ${ctx.host}]`
);
console.error(BETA_NOTICE);
