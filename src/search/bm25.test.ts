import { describe, it, expect } from "vitest";
import { tokenize, Bm25Index } from "./bm25.js";

describe("tokenize", () => {
  it("splits camelCase and punctuation, lowercases", () => {
    expect(tokenize("createAgentRuntime")).toEqual(["create", "agent", "runtime"]);
    expect(tokenize("Registry Credential (Admin)")).toEqual([
      "registry",
      "credential",
      "admin",
    ]);
  });
});

describe("Bm25Index", () => {
  const index = new Bm25Index([
    { id: "runtime.createAgentRuntime", text: "create an agent runtime POST /v3/agent-runtimes" },
    { id: "runtime.listAgentRuntimes", text: "list agent runtimes GET /v3/agent-runtimes" },
    { id: "cr.getCredential", text: "get registry credential GET /credentials" },
  ]);

  it("ranks the most relevant doc first", () => {
    const hits = index.query("create runtime", 5);
    expect(hits[0].id).toBe("runtime.createAgentRuntime");
  });

  it("respects the limit", () => {
    const hits = index.query("agent", 1);
    expect(hits.length).toBe(1);
  });

  it("returns empty for no term overlap", () => {
    expect(index.query("zzzznotaword", 5)).toEqual([]);
  });
});
