import { describe, it, expect } from "vitest";
import { listServers, searchTools, executeTool } from "./handlers.js";
import type { HandlerDeps } from "./handlers.js";
import { RegistryStore } from "../registry/loader.js";
import { Bm25SearchEngine } from "../search/engine.js";
import type { Registry } from "../registry/types.js";

const reg: Registry = {
  operations: [
    {
      id: "runtime.getAgentRuntime",
      service: "runtime",
      operationId: "getAgentRuntime",
      method: "GET",
      path: "/v3/agent-runtimes/{id}",
      summary: "Get agent runtime",
      tags: ["agent-runtime"],
      parameters: [
        { name: "id", location: "path", required: true, schema: { type: "string" } },
      ],
      hasBody: false,
      bodyRequired: false,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  ],
};

function deps(fetchImpl?: any): HandlerDeps {
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
    fetchImpl,
  };
}

describe("meta-tool handlers", () => {
  it("list_servers reports the runtime service", () => {
    const r = listServers(deps());
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.find((s: any) => s.name === "runtime").operationCount).toBe(1);
  });

  it("search_tools returns a rich hit with inputSchema", () => {
    const r = searchTools(deps(), { query: "get agent runtime" });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed[0].id).toBe("runtime.getAgentRuntime");
    expect(parsed[0].inputSchema.required).toContain("id");
  });

  it("execute calls downstream with the bearer token and projects fields", async () => {
    const cap: any = {};
    const fetchImpl = async (url: string, init: any) => {
      cap.url = url;
      cap.auth = init.headers.Authorization;
      return {
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ id: "r1", status: "RUNNING", secret: "x" }),
      };
    };
    const r = await executeTool(deps(fetchImpl), { bearerToken: "TKN" }, {
      id: "runtime.getAgentRuntime",
      args: { id: "r1" },
      fields: "{id: id, status: status}",
    });
    expect(cap.url).toBe("https://h/runtime/v3/agent-runtimes/r1");
    expect(cap.auth).toBe("Bearer TKN");
    expect(JSON.parse(r.content[0].text)).toEqual({ id: "r1", status: "RUNNING" });
  });

  it("execute returns an error result for an unknown id", async () => {
    const r = await executeTool(deps(), { bearerToken: "T" }, { id: "nope.nope" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/unknown operation/i);
  });
});
