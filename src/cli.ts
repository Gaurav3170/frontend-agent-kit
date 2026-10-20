#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ToolError } from "./lib/errors.js";
import { runLighthouse } from "./lib/lighthouse.js";
import { createRegistry } from "./lib/registry.js";
import { createServer, TOOLS } from "./server.js";
import type { ToolDeps } from "./tools/types.js";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const USAGE = `Usage:
  frontend-agent-kit                 Start the MCP server on stdio (what an MCP client runs)
  frontend-agent-kit <tool> [options]  Run one tool and print its report

Tools:
${TOOLS.map((tool) => `  ${tool.name.padEnd(24)} ${tool.title}`).join("\n")}

Options (each tool uses the ones it needs):
  --project <dir>     Project root (default: current directory)
  --url <url>         Page to audit (run_lighthouse)
  --desktop           Desktop instead of mobile (run_lighthouse)
  --categories <list> Comma-separated, e.g. performance,accessibility (run_lighthouse)
  --budget-kb <n>     First-load JS budget per route, gzip kB (analyze_bundle)
  --target <major>    Next.js major to upgrade to (check_nextjs_upgrade)
  --min-severity <s>  low | moderate | high | critical (audit_dependencies)
  --help, --version`;

function deps(): ToolDeps {
  return { registry: createRegistry(), lighthouse: runLighthouse, nodeVersion: process.versions.node };
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: "string" },
      url: { type: "string" },
      desktop: { type: "boolean" },
      categories: { type: "string" },
      "budget-kb": { type: "string" },
      target: { type: "string" },
      "min-severity": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) return print(USAGE, 0);
  if (values.version) return print(VERSION, 0);

  const [name] = positionals;
  if (!name) {
    // MCP mode: stdout carries the protocol, so nothing else may write to it.
    const server = createServer(deps(), VERSION);
    await server.connect(new StdioServerTransport());
    return -1;
  }

  const tool = TOOLS.find((candidate) => candidate.name === name || candidate.name === name.replace(/-/g, "_"));
  if (!tool) return print(`Unknown tool "${name}".\n\n${USAGE}`, 2);
  const args = z.object(tool.inputSchema).parse({
    projectDir: values.project ? (await import("node:path")).resolve(values.project) : undefined,
    url: values.url,
    formFactor: values.desktop ? "desktop" : undefined,
    categories: values.categories?.split(",").map((c) => c.trim()),
    budgetKb: values["budget-kb"] ? Number(values["budget-kb"]) : undefined,
    targetMajor: values.target ? Number(values.target) : undefined,
    minSeverity: values["min-severity"],
  });
  return print(await tool.run(args as never, deps()), 0);
}

function print(text: string, code: number): number {
  (code === 0 ? process.stdout : process.stderr).write(`${text}\n`);
  return code;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof z.ZodError) {
      process.stderr.write(`Invalid options: ${error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}\n`);
    } else if (error instanceof ToolError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(`${process.env["DEBUG"] ? (error as Error).stack : (error as Error).message}\n`);
    }
    process.exitCode = error instanceof ToolError || error instanceof z.ZodError ? 2 : 1;
  },
);
