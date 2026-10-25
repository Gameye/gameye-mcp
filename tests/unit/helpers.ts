import { vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../../src/tools/common.js";
import { DEFAULT_LIMITS } from "../../src/env.js";

export type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export interface ToolConfig {
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, boolean | undefined>;
}

/** Captures registerTool(name, config, handler) calls. */
export function makeMockServer() {
  const handlers: Record<string, ToolHandler> = {};
  const configs: Record<string, ToolConfig> = {};
  const server = {
    registerTool: (name: string, config: ToolConfig, handler: ToolHandler) => {
      handlers[name] = handler;
      configs[name] = config;
    },
  } as unknown as McpServer;
  return { server, handlers, configs };
}

export function makeContext(overrides: Partial<ServerContext> = {}): ServerContext {
  return {
    environment: "sandbox",
    host: "api.sandbox-gameye.gameye.net",
    baseUrl: "https://api.sandbox-gameye.gameye.net",
    version: "0.0.0-test",
    limits: DEFAULT_LIMITS,
    mask: (text: string) => text.split(TEST_TOKEN).join("***"),
    ...overrides,
  };
}

export const SANDBOX_PREFIX = "[sandbox · api.sandbox-gameye.gameye.net]";
export const PRODUCTION_PREFIX = "[production · api.production-gameye.gameye.net]";

export function makeProductionContext(): ServerContext {
  return makeContext({
    environment: "production",
    host: "api.production-gameye.gameye.net",
    baseUrl: "https://api.production-gameye.gameye.net",
  });
}

/** The token the mock client treats as configured. */
export const TEST_TOKEN = "gy_test_token_0123456789abcdef";

export function makeMockClient(token = TEST_TOKEN) {
  return {
    containsToken: (text: string) => text.includes(token),
    maskToken: (text: string) => text.split(token).join("***"),
    listRegions: vi.fn(),
    listApplications: vi.fn(),
    listRegistryTags: vi.fn(),
    enableTag: vi.fn(),
    createApplication: vi.fn(),
    editApplication: vi.fn(),
    createToken: vi.fn(),
    launchSession: vi.fn(),
    listSessions: vi.fn(),
    describeSession: vi.fn(),
    stopSession: vi.fn(),
    playerJoin: vi.fn(),
    playerLeave: vi.fn(),
    getAvailableLocations: vi.fn(),
    checkTag: vi.fn(),
    getLogs: vi.fn(),
    getArtifacts: vi.fn(),
  };
}

/** Extract the text of the first content block from a tool result. */
export function getText(result: ToolResult): string {
  return result.content[0].text;
}

/** Parse a URL regardless of whether fetch was called with a string or URL object. */
export function capturedUrl(mock: ReturnType<typeof vi.fn>, callIdx = 0): URL {
  const arg = mock.mock.calls[callIdx][0];
  return arg instanceof URL ? arg : new URL(String(arg));
}
