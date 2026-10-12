import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GameyeClient } from "../client.js";
import { DEFAULT_TOKEN_EXPIRY, GuardError, checkTokenOutputPath, formatDryRun, reserveTokenFile } from "../guards.js";
import { defineTool, type ServerContext } from "./common.js";

export function registerTokenTools(server: McpServer, client: GameyeClient, ctx: ServerContext): void {
  defineTool(
    server,
    ctx,
    "gameye_create_token",
    {
      title: "Create API token",
      description:
        "Admin tool. Create a Gameye API token and write it to a file; the token value is never returned. " +
        "outputPath must be an absolute path outside any git working tree; an existing file is refused unless overwrite=true, and symlinks are always refused. " +
        `The file is created with 0600 permissions. expires_after defaults to ${DEFAULT_TOKEN_EXPIRY}. ` +
        "Requested scopes must be a subset of this server's token scopes (webhook:github is the one exception). Needs the token:write scope. Pass dryRun=true to preview the request.",
      inputSchema: {
        name: z.string().min(1).describe("Token name"),
        scopes: z.array(z.string().min(1)).min(1).describe("Scopes for the new token, e.g. ['session:read']"),
        expires_after: z
          .string()
          .min(1)
          .optional()
          .describe(`Lifetime such as '1h' or '2h30m' (units m and h). Defaults to ${DEFAULT_TOKEN_EXPIRY}`),
        outputPath: z.string().min(1).describe("Absolute path of the file to write the token to"),
        overwrite: z.boolean().optional().describe("Replace an existing regular file at outputPath"),
        dryRun: z
          .boolean()
          .optional()
          .describe("Check outputPath and return the request that would be sent; create nothing"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ name, scopes, expires_after, outputPath, overwrite, dryRun }) => {
      const defaultExpiry = !expires_after;
      const body = { name, scopes, expires_after: expires_after ?? DEFAULT_TOKEN_EXPIRY };
      const expiryLine = `  Expires: after ${body.expires_after}${defaultExpiry ? " (default applied because no expires_after was given)" : ""}`;

      if (dryRun) {
        const path = await checkTokenOutputPath(outputPath, overwrite ?? false);
        return [
          formatDryRun(ctx, GameyeClient.createTokenRequest(body), client),
          "",
          `The token would be written to ${path} with 0600 permissions.`,
          expiryLine.trim(),
        ].join("\n");
      }

      // Reserve the file first, so a bad path never mints a token.
      const file = await reserveTokenFile(outputPath, overwrite ?? false);
      let secret: string;
      try {
        secret = await client.createToken(body);
      } catch (err) {
        await file.abort();
        throw err;
      }
      try {
        await file.commit(secret);
      } catch (err) {
        // The token now exists on the server but its only copy is gone.
        const reason = err instanceof Error ? err.message : String(err);
        throw new GuardError(
          `Token "${name}" was created on ${ctx.host} but could not be written to ${file.path}: ${reason}. ` +
            `The secret is lost; revoke this token (it expires in ${body.expires_after}).`
        );
      }

      return [
        "Token created and written to file. The token value is not shown.",
        `  File:    ${file.path} (permissions 0600)`,
        `  Scopes:  ${scopes.join(", ")}`,
        expiryLine,
      ].join("\n");
    }
  );
}
