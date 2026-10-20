import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolError } from "./lib/errors.js";
import { analyzeBundle } from "./tools/analyze-bundle.js";
import { auditDependencies } from "./tools/audit-dependencies.js";
import { checkNextjsUpgrade } from "./tools/check-nextjs-upgrade.js";
import { findUnoptimizedImages } from "./tools/find-unoptimized-images.js";
import { runLighthouseTool } from "./tools/run-lighthouse.js";
import type { ToolDefinition, ToolDeps } from "./tools/types.js";

export const TOOLS: readonly ToolDefinition[] = [
  analyzeBundle,
  auditDependencies,
  runLighthouseTool,
  findUnoptimizedImages,
  checkNextjsUpgrade,
] as unknown as ToolDefinition[];

const INSTRUCTIONS = `Tools for frontend performance, dependency security and upgrades. Every tool only reads; none edits files or installs packages.
Pass projectDir as the absolute path of the user's project; this server's working directory may be somewhere else.
Each tool returns a markdown report. Quote its numbers rather than estimating, and say when a result is lab data or a static scan.`;

export function createServer(deps: ToolDeps, version: string): McpServer {
  const server = new McpServer({ name: "frontend-agent-kit", version }, { instructions: INSTRUCTIONS });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        // None of the tools change anything; openWorld marks the ones that reach the network.
        annotations: { readOnlyHint: true, openWorldHint: tool.network },
      },
      async (args: Record<string, unknown>) => {
        try {
          return { content: [{ type: "text" as const, text: await tool.run(args as never, deps) }] };
        } catch (error) {
          // Expected failures read as advice; anything else gets its message so the agent can report it.
          const message = error instanceof ToolError ? error.message : `${tool.name} failed: ${(error as Error).message}`;
          return { content: [{ type: "text" as const, text: message }], isError: true };
        }
      },
    );
  }
  return server;
}
