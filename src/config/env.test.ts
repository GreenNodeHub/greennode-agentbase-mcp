import { describe, it, expect } from "vitest";
import { loadEnvConfig, SERVICES } from "./env.js";

const base = {} as NodeJS.ProcessEnv;

describe("loadEnvConfig", () => {
  it("resolves prod base urls for all seven services", () => {
    const cfg = loadEnvConfig(base);
    expect(Object.keys(cfg.baseUrls).sort()).toEqual([...SERVICES].sort());
    expect(cfg.baseUrls.memory).toBe("https://agentbase.api.vngcloud.vn/memory");
    expect(cfg.baseUrls.policy).toBe("https://agentbase.api.vngcloud.vn/policy");
    expect(cfg.baseUrls.tools).toBe(
      "https://agentbase.api.vngcloud.vn/built-in-tools/v1",
    );
  });

  it("applies defaults", () => {
    const cfg = loadEnvConfig(base);
    expect(cfg.maxResponseBytes).toBe(25_000);
    expect(cfg.port).toBe(8080);
    expect(cfg.searchLimitDefault).toBe(5);
  });

  it("defaults TRANSPORT to stdio", () => {
    const cfg = loadEnvConfig(base);
    expect(cfg.transport).toBe("stdio");
  });

  it("accepts TRANSPORT=http and rejects other values", () => {
    expect(loadEnvConfig({ ...base, TRANSPORT: "http" }).transport).toBe("http");
    expect(loadEnvConfig({ ...base, TRANSPORT: "stdio" }).transport).toBe("stdio");
    expect(() => loadEnvConfig({ ...base, TRANSPORT: "ws" })).toThrow(/TRANSPORT/);
  });

  it("defaults TOKEN_ENV to GREENNODE_MCP_TOKEN", () => {
    const cfg = loadEnvConfig(base);
    expect(cfg.tokenEnv).toBe("GREENNODE_MCP_TOKEN");
  });

  it("reflects a custom TOKEN_ENV", () => {
    const cfg = loadEnvConfig({ ...base, TOKEN_ENV: "MY_TOKEN" });
    expect(cfg.tokenEnv).toBe("MY_TOKEN");
  });
});
