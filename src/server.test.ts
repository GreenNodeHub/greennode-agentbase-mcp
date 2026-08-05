import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type ServerDeps } from "./server.js";
import { RegistryStore } from "./registry/loader.js";
import { Bm25SearchEngine } from "./search/engine.js";
import type { Registry } from "./registry/types.js";

const reg: Registry = {
  operations: [
    {
      id: "runtime.listAgentRuntimes",
      service: "runtime",
      operationId: "listAgentRuntimes",
      method: "GET",
      path: "/v3/agent-runtimes",
      summary: "List agent runtimes",
      tags: ["agent-runtime"],
      parameters: [],
      hasBody: false,
      bodyRequired: false,
      inputSchema: { type: "object", properties: {} },
    },
  ],
};

function deps(): ServerDeps {
  const store = RegistryStore.fromObject(reg);
  return {
    registry: store,
    engine: new Bm25SearchEngine(store.all(), 5),
    config: {
      baseUrls: { runtime: "https://h/runtime" },
      maxResponseBytes: 25_000,
      port: 8080,
      searchLimitDefault: 5,
      transport: "http",
      tokenEnv: "GREENNODE_MCP_TOKEN",
    },
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify([{ id: "r1" }]),
    }),
  };
}

describe("createMcpServer", () => {
  it("exposes exactly the 3 meta-tools and runs them end to end", async () => {
    const server = createMcpServer(deps(), { bearerToken: "TKN" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "execute",
      "list_servers",
      "search_tools",
    ]);

    const search = await client.callTool({
      name: "search_tools",
      arguments: { query: "list agent runtimes" },
    });
    const hits = JSON.parse((search.content as any)[0].text);
    expect(hits[0].id).toBe("runtime.listAgentRuntimes");

    const exec = await client.callTool({
      name: "execute",
      arguments: { id: "runtime.listAgentRuntimes", args: {} },
    });
    expect(JSON.parse((exec.content as any)[0].text)).toEqual([{ id: "r1" }]);
  });
});
