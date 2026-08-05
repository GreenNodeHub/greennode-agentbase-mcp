import { describe, it, expect } from "vitest";
import { Bm25SearchEngine } from "./engine.js";
import type { RegistryOperation } from "../registry/types.js";

function op(partial: Partial<RegistryOperation>): RegistryOperation {
  return {
    id: "x.y",
    service: "x",
    operationId: "y",
    method: "GET",
    path: "/y",
    summary: "",
    tags: [],
    parameters: [],
    hasBody: false,
    bodyRequired: false,
    inputSchema: { type: "object", properties: {} },
    ...partial,
  };
}

const ops = [
  op({ id: "runtime.createAgentRuntime", service: "runtime", operationId: "createAgentRuntime", method: "POST", path: "/v3/agent-runtimes", summary: "Create an agent runtime", tags: ["agent-runtime"] }),
  op({ id: "runtime.listAgentRuntimes", service: "runtime", operationId: "listAgentRuntimes", path: "/v3/agent-runtimes", summary: "List agent runtimes", tags: ["agent-runtime"] }),
  op({ id: "cr.getCredential", service: "cr", operationId: "getCredential", path: "/credentials", summary: "Get registry credential", tags: ["Registry Credential"] }),
];

describe("Bm25SearchEngine", () => {
  const engine = new Bm25SearchEngine(ops, 5);

  it("returns rich hits with inputSchema inline", () => {
    const hits = engine.search("create agent runtime");
    expect(hits[0].id).toBe("runtime.createAgentRuntime");
    expect(hits[0].inputSchema).toBeDefined();
    expect(hits[0].service).toBe("runtime");
  });

  it("scopes results to a server when given", () => {
    const hits = engine.search("credential", { server: "runtime" });
    expect(hits.every((h) => h.service === "runtime")).toBe(true);
  });

  it("honors an explicit limit", () => {
    const hits = engine.search("agent", { limit: 1 });
    expect(hits.length).toBeLessThanOrEqual(1);
  });
});
