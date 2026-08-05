import { describe, it, expect } from "vitest";
import { RegistryStore } from "./loader.js";
import type { Registry } from "./types.js";

const fixture: Registry = {
  operations: [
    {
      id: "runtime.createAgentRuntime",
      service: "runtime",
      operationId: "createAgentRuntime",
      method: "POST",
      path: "/v3/agent-runtimes",
      summary: "Create an agent runtime",
      tags: ["agent-runtime"],
      parameters: [],
      hasBody: true,
      bodyRequired: true,
      inputSchema: { type: "object", properties: {} },
    },
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
    {
      id: "policy.listPolicies",
      service: "policy",
      operationId: "listPolicies",
      method: "GET",
      path: "/policies",
      summary: "List policies",
      tags: ["policies"],
      parameters: [],
      hasBody: false,
      bodyRequired: false,
      inputSchema: { type: "object", properties: {} },
    },
  ],
};

describe("RegistryStore", () => {
  const store = RegistryStore.fromObject(fixture);

  it("looks up an operation by id", () => {
    expect(store.getById("runtime.createAgentRuntime")?.method).toBe("POST");
    expect(store.getById("nope")).toBeUndefined();
  });

  it("groups operations into servers with counts and tags", () => {
    const servers = store.servers();
    const runtime = servers.find((s) => s.name === "runtime")!;
    expect(runtime.operationCount).toBe(2);
    expect(runtime.tags).toContain("agent-runtime");
    expect(servers.map((s) => s.name).sort()).toEqual(["policy", "runtime"]);
  });
});
