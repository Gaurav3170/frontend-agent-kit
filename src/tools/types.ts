import type { ZodRawShape, z } from "zod";
import type { LighthouseRunner } from "../lib/lighthouse.js";
import type { Registry } from "../lib/registry.js";

/** Outside services, injected so tests can replace them. */
export interface ToolDeps {
  registry: Registry;
  lighthouse: LighthouseRunner;
  /** The Node.js version the user's project will run with locally, e.g. "18.17.1". */
  nodeVersion: string;
}

export interface ToolDefinition<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  /** What the tool does and when an agent should call it. Agents pick tools from this text. */
  description: string;
  /** Whether it reaches the network (the npm registry, or the URL it audits). */
  network: boolean;
  inputSchema: Shape;
  /** Returns a markdown report written for the agent to read and act on. */
  run(args: z.objectOutputType<Shape, z.ZodTypeAny>, deps: ToolDeps): Promise<string>;
}

export function defineTool<Shape extends ZodRawShape>(tool: ToolDefinition<Shape>): ToolDefinition<Shape> {
  return tool;
}
