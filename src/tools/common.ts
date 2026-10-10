import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { GameyeError, GameyeTimeoutError, redactLabels } from "../client.js";
import { resultPrefix, type EnvironmentLabel } from "../env.js";
import { GuardError } from "../guards.js";

/** Shared `dryRun` input for every tool that sends a write. */
export const dryRunInput = z
  .boolean()
  .optional()
  .describe("Return the exact request that would be sent, with the API token masked, and send nothing");

/** Tool registration options. Admin tools only when GAMEYE_ENABLE_ADMIN_TOOLS=1. */
export interface RegisterOptions {
  /** Register admin tools (create/edit application, create token). */
  admin: boolean;
}

/** What every tool needs to know about the server it runs in. Never holds the token. */
export interface ServerContext {
  environment: EnvironmentLabel;
  host: string;
  baseUrl: string;
  version: string;
  /** Replace the API token with `***`. Applied to every tool result, success or error. */
  mask: (text: string) => string;
}

/** A handler returns plain text, or text plus an error flag for handled failures. */
export type ToolOutput = string | { text: string; isError?: boolean };

export interface ToolDefinition<Shape extends z.ZodRawShape> {
  title: string;
  description: string;
  inputSchema: Shape;
  annotations: ToolAnnotations;
  /** Extra hint appended to the error text for a GameyeError, e.g. for a 404. */
  errorHint?: (err: GameyeError) => string | undefined;
}

/**
 * Register a tool so that every result starts with the environment and host,
 * has the API token masked (log output, labels and error messages can echo
 * it), and every failure comes back as `isError: true` with the server's details
 * and trace ID instead of being thrown. A GuardError (a refusal before any
 * request) comes back as `isError: true` with its message.
 */
export function defineTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  ctx: ServerContext,
  name: string,
  def: ToolDefinition<Shape>,
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolOutput>
): void {
  const prefix = resultPrefix(ctx);
  const wrap = (text: string, isError?: boolean): CallToolResult => ({
    content: [{ type: "text", text: ctx.mask(`${prefix}\n${text}`) }],
    ...(isError ? { isError: true } : {}),
  });

  const callback = async (args: z.infer<z.ZodObject<Shape>>): Promise<CallToolResult> => {
    try {
      const out = await handler(args);
      return typeof out === "string" ? wrap(out) : wrap(out.text, out.isError);
    } catch (err) {
      if (err instanceof GuardError || err instanceof GameyeTimeoutError) return wrap(err.message, true);
      if (err instanceof GameyeError) {
        const hint = def.errorHint?.(err);
        return wrap([err.toDisplayString(), hint].filter(Boolean).join("\n\n"), true);
      }
      const message = err instanceof Error ? err.message : String(err);
      return wrap(`Request to ${ctx.host} failed: ${message}`, true);
    }
  };

  server.registerTool(
    name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: def.annotations,
    },
    callback as never
  );
}

/** Format labels for display, never showing the value of the `env` label. */
export function formatLabels(labels: Record<string, string> | undefined, sep: string, kv: string): string {
  const safe = redactLabels(labels);
  if (!safe || Object.keys(safe).length === 0) return "";
  return Object.entries(safe)
    .map(([k, v]) => `${k}${kv}${v}`)
    .join(sep);
}
