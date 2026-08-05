import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const tsx = resolve("node_modules/.bin/tsx");
const index = resolve("src/index.ts");

// Build a hermetic env: inherit OS essentials (PATH, HOME, …) but NOT the
// app's own config env vars — vitest's worker sets TRANSPORT/MODE/ENV that
// would make loadEnvConfig take the wrong path. The caller controls all app
// config via `overrides`.
const APP_ENV_KEYS = ["ENV", "TRANSPORT", "TOKEN_ENV", "GREENNODE_MCP_TOKEN"];

function runStdio(overrides: Record<string, string>, stdin = "") {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of APP_ENV_KEYS) delete env[k];
  Object.assign(env, overrides);
  return spawnSync(tsx, [index], {
    input: stdin,
    env,
    timeout: 30_000,
    encoding: "utf8",
  });
}

const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  },
});
const LIST = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });

function parseToolsList(stdout: string): unknown[] {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed);
      if (msg?.id === 2) return msg?.result?.tools ?? [];
    } catch {
      // not a JSON-RPC line; skip
    }
  }
  return [];
}

describe("stdio transport (smoke)", () => {
  it("exits non-zero with a stderr message when the token is missing", () => {
    const res = runStdio({ TRANSPORT: "stdio" }); // no token
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/token/i);
  });

  it("lists 3 tools (gateway) over stdio", () => {
    const res = runStdio(
      { TRANSPORT: "stdio", GREENNODE_MCP_TOKEN: "T" },
      `${INIT}\n${LIST}\n`,
    );
    expect(res.status).toBe(0);
    expect(parseToolsList(res.stdout)).toHaveLength(3);
  });
});
