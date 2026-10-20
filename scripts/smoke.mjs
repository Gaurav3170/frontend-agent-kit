// Starts the built server over stdio the way an MCP client does, lists its tools and
// calls one. Run after `npm run build`: node scripts/smoke.mjs [projectDir] [tool]
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectDir = resolve(process.argv[2] ?? ".");
const tool = process.argv[3] ?? "find_unoptimized_images";
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/cli.js"] }));
const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
const result = await client.callTool({ name: tool, arguments: { projectDir } });
console.log(result.content[0].text.split("\n").slice(0, 12).join("\n"));
await client.close();
if (tools.length !== 5 || result.isError) process.exit(1);
