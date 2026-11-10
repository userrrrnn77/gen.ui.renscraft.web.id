// src/tools/index.ts

import { z } from "zod";
import { listTools, listToolNames } from "./registry.js";
import type { ToolDefinition } from "../llm/nvidiaClient.js";

// Side-effect: register tools
import "./ui.js";
import "./files.js";
import "./attachments.js";

export { getTool, listTools, listToolNames } from "./registry.js";
export type { ToolContext, ToolResult, ToolDef } from "./registry.js";

export function buildToolDefinitions(): ToolDefinition[] {
  return listTools().map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.schema, {
        target: "draft-7",
        io: "input",
      }) as Record<string, unknown>,
    },
  }));
}
