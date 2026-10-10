import { createRequire } from "node:module";

/** This package's version, read from package.json so it can't drift. */
export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

/**
 * The User-Agent sent on every Gameye API request, so Gameye can tell MCP
 * traffic apart from other clients. Holds only this server's version and, when
 * known, the MCP client's name. Never a token or any env value.
 */
export function userAgent(clientName?: string): string {
  const base = `gameye-mcp/${VERSION}`;
  // Keep header-safe characters only, so a client name can't break the header.
  const name = clientName?.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
  return name ? `${base} (${name})` : base;
}
