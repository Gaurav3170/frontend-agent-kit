/**
 * An expected failure whose message is written for the agent: what went wrong and what
 * to do about it. The server returns it as a tool error instead of a protocol error, so
 * the agent can read it and recover (pass a different path, build first, and so on).
 */
export class ToolError extends Error {
  override name = "ToolError";
}
