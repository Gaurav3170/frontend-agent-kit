import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { deps, project } from "./helpers.js";

async function connect() {
  const server = createServer(deps(), "0.0.0-test");
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("MCP server", () => {
  it("lists the five read-only tools with input schemas", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "analyze_bundle",
      "audit_dependencies",
      "check_nextjs_upgrade",
      "find_unoptimized_images",
      "run_lighthouse",
    ]);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
      assert.equal(tool.inputSchema.type, "object");
    }
    const lighthouse = tools.find((tool) => tool.name === "run_lighthouse")!;
    assert.deepEqual(lighthouse.inputSchema.required, ["url"]);
    assert.equal(tools.find((tool) => tool.name === "find_unoptimized_images")!.annotations?.openWorldHint, false);
  });

  it("returns a tool's report as text", async () => {
    const client = await connect();
    const dir = project({ "package.json": {}, "index.html": "<p>hi</p>" });
    const result = await client.callTool({ name: "find_unoptimized_images", arguments: { projectDir: dir } });
    assert.equal(result.isError, undefined);
    assert.match((result.content as { text: string }[])[0]!.text, /No problems found/);
  });

  it("returns expected failures as readable tool errors", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "analyze_bundle", arguments: { projectDir: "relative/path" } });
    assert.equal(result.isError, true);
    assert.match((result.content as { text: string }[])[0]!.text, /must be an absolute path/);
  });

  it("rejects invalid arguments before running the tool", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "run_lighthouse", arguments: { url: "not a url" } });
    assert.equal(result.isError, true);
    assert.match((result.content as { text: string }[])[0]!.text, /url|Invalid/i);
  });
});
