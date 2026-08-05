import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp, buildServer } from "./app.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RegistryStore } from "./registry/loader.js";
import { Bm25SearchEngine } from "./search/engine.js";
import type { Registry } from "./registry/types.js";

const reg: Registry = { operations: [] };

function testApp() {
  const store = RegistryStore.fromObject(reg);
  return createApp({
    registry: store,
    engine: new Bm25SearchEngine(store.all(), 5),
    config: {
      baseUrls: {},
      maxResponseBytes: 25_000,
      port: 8080,
      searchLimitDefault: 5,
      transport: "http",
      tokenEnv: "GREENNODE_MCP_TOKEN",
    },
  });
}

describe("createApp auth gate", () => {
  it("responds ok on /healthz without auth", async () => {
    const res = await request(testApp()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("responds ok on /health without auth", async () => {
    const res = await request(testApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("rejects /mcp with 401 when the bearer token is missing", async () => {
    const res = await request(testApp()).post("/mcp").send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing upstream token/i);
  });

  it("passes the auth gate with a valid bearer token", async () => {
    const res = await request(testApp())
      .post("/mcp")
      .set("Authorization", "Bearer T")
      .send({});
    // Past the auth gate: never 401. The exact status depends on MCP
    // transport/JSON-RPC handling of the body, which is covered separately
    // by server.test.ts's in-memory round-trip.
    expect(res.status).not.toBe(401);
  });
});

describe("buildServer", () => {
  it("returns a gateway McpServer", () => {
    const store = RegistryStore.fromObject({ operations: [] });
    const server = buildServer(
      {
        registry: store,
        engine: new Bm25SearchEngine(store.all(), 5),
        config: {
          baseUrls: {},
          maxResponseBytes: 25_000,
          port: 8080,
          searchLimitDefault: 5,
          transport: "stdio",
          tokenEnv: "GREENNODE_MCP_TOKEN",
        },
      },
      { bearerToken: "T" },
    );
    expect(server).toBeInstanceOf(McpServer);
  });
});
