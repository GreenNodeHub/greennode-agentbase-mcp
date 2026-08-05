import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EnvConfig } from "./config/env.js";
import type { RegistryStore } from "./registry/loader.js";
import type { SearchEngine } from "./search/engine.js";
import type { FetchLike } from "./http/downstream.js";
import type { AuthContext } from "./auth/inbound.js";
import {
  listServers,
  searchTools,
  executeTool,
  type HandlerDeps,
} from "./meta-tools/handlers.js";

export interface ServerDeps {
  registry: RegistryStore;
  engine: SearchEngine;
  config: EnvConfig;
  fetchImpl?: FetchLike;
}

export function createMcpServer(
  deps: ServerDeps,
  auth: AuthContext,
): McpServer {
  const handlerDeps: HandlerDeps = deps;
  const server = new McpServer({
    name: "greennode-agentbase-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "list_servers",
    {
      description:
        "List the available AgentBase services with operation counts and tags. Call this first to orient.",
      inputSchema: {},
    },
    async () => listServers(handlerDeps) as any,
  );

  server.registerTool(
    "search_tools",
    {
      description:
        "Search for API operations by intent. Returns matches with their full input schema inline, ready to pass to execute. Optionally scope to one server.",
      inputSchema: {
        query: z.string().describe("Natural-language description of the operation you need"),
        server: z
          .string()
          .optional()
          .describe("Optional service name to scope the search"),
        limit: z.number().int().positive().max(25).optional(),
      },
    },
    async (args) => searchTools(handlerDeps, args) as any,
  );

  server.registerTool(
    "execute",
    {
      description:
        "Execute an API operation by id (from search_tools). Pass args matching its inputSchema. Optional 'fields' is a JMESPath expression that projects the response to reduce size.",
      inputSchema: {
        id: z.string().describe("Operation id, e.g. runtime.list_1 — always take it from search_tools, since ids mirror the upstream spec's operationId"),
        args: z.record(z.any()).optional(),
        fields: z
          .string()
          .optional()
          .describe("JMESPath projection over the response"),
      },
    },
    async (args) => executeTool(handlerDeps, auth, args) as any,
  );

  return server;
}
