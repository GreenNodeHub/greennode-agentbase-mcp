# Local stdio MCP Server Implementation Plan

> **Update (2026-07-06):** `MODE` (gateway|flat) and `ENV` (dev|prod) were removed after this plan was written — the server is gateway-only and prod-only now. The `TRANSPORT` (stdio|http) work here stands unchanged.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an agent-agnostic stdio transport to the AgentBase MCP server so any MCP-speaking client can run the gateway locally as `TRANSPORT=stdio tsx src/index.ts`, with the upstream bearer token read from a configurable env var.

**Architecture:** A third env-var axis `TRANSPORT` (default `stdio`) branches once at the top of `index.ts`: `http` keeps the current `createApp()` + `app.listen()` path; `stdio` builds one long-lived MCP server via a shared `buildServer(deps, auth)` helper and connects it to a `StdioServerTransport`. The token for stdio comes from the env var named by `TOKEN_ENV` (default `GREENNODE_MCP_TOKEN`) via a new `authenticateFromEnv`. The server builders, handlers, registry, BM25 engine, downstream caller, and projection are untouched — transport is a wiring concern at the entry point.

**Tech Stack:** TypeScript (NodeNext, strict), `@modelcontextprotocol/sdk` v1.29.0 (`StdioServerTransport`), `tsx` runner, `vitest`, Express 5 (HTTP path only).

## Global Constraints

- Node `>=20`; ESM (`"type": "module"`); TypeScript strict, `noEmit` (runner is `tsx`, no compiled build).
- `loadEnvConfig` throws on invalid env values at boot — `TRANSPORT` follows the same pattern as `MODE`/`ENV`.
- `TRANSPORT` defaults to `"stdio"`; `TOKEN_ENV` defaults to `"GREENNODE_MCP_TOKEN"`.
- **stdout is the JSON-RPC protocol in stdio mode** — all diagnostics go to `console.error` (stderr), unconditionally (harmless for HTTP).
- Server builders, handlers, `callDownstream`, projection, registry, and search are **not modified**.
- Deployed HTTP runtimes must set `TRANSPORT=http` (migration note in spec).

---

## File Structure

- **`src/config/env.ts`** (modify) — add `transport` and `tokenEnv` to `EnvConfig` + `loadEnvConfig` validation.
- **`src/config/env.test.ts`** (modify) — tests for `TRANSPORT` and `TOKEN_ENV`.
- **`src/auth/inbound.ts`** (modify) — add `authenticateFromEnv(env, tokenEnv)`.
- **`src/auth/inbound.test.ts`** (modify) — tests for `authenticateFromEnv`.
- **`src/app.ts`** (modify) — export `buildServer(deps, auth)`; refactor `createApp` to call it.
- **`src/app.test.ts`** (modify) — test for `buildServer`; update the two `EnvConfig` literals with the new fields.
- **`src/server.test.ts`**, **`src/server-flat.test.ts`**, **`src/meta-tools/handlers.test.ts`** (modify) — add the two new `EnvConfig` fields to each literal so the typecheck passes.
- **`src/index.ts`** (modify) — branch on `config.transport`; stdio path with `StdioServerTransport`; HTTP logging to stderr.
- **`src/stdio.smoke.test.ts`** (create) — spawn-the-process integration tests (missing token; gateway tools/list; flat tools/list).

---

### Task 1: Add `TRANSPORT` and `TOKEN_ENV` to `EnvConfig`

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/config/env.test.ts`
- Modify: `src/app.test.ts` (two `EnvConfig` literals)
- Modify: `src/server.test.ts` (one literal)
- Modify: `src/server-flat.test.ts` (one literal)
- Modify: `src/meta-tools/handlers.test.ts` (one literal)

**Interfaces:**
- Produces: `EnvConfig.transport: "stdio" | "http"` and `EnvConfig.tokenEnv: string`, read by Task 4 (`index.ts`) and indirectly by `buildServer` (Task 3) via `deps.config`.

- [ ] **Step 1: Write the failing tests in `src/config/env.test.ts`**

Add these tests inside the existing `describe("loadEnvConfig", …)` block, after the MODE tests:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/config/env.test.ts`
Expected: FAIL — `cfg.transport` is `undefined`, `cfg.tokenEnv` is `undefined`.

- [ ] **Step 3: Implement in `src/config/env.ts`**

Add the type union and the two fields. Edit the `ServerMode` section and the `EnvConfig` interface:

```ts
export type ServerMode = "gateway" | "flat";
export type Transport = "stdio" | "http";

export interface EnvConfig {
  environment: Environment;
  baseUrls: Record<string, string>;
  maxResponseBytes: number;
  port: number;
  searchLimitDefault: number;
  mode: ServerMode;
  transport: Transport;
  tokenEnv: string;
}
```

In `loadEnvConfig`, after the `mode` block and before the `return`, add:

```ts
  const transportRaw = env.TRANSPORT ?? "stdio";
  if (transportRaw !== "stdio" && transportRaw !== "http") {
    throw new Error(
      `Invalid TRANSPORT "${transportRaw}": expected "stdio" or "http"`,
    );
  }
  const transport = transportRaw as Transport;

  const tokenEnv = env.TOKEN_ENV ?? "GREENNODE_MCP_TOKEN";
```

Add `transport` and `tokenEnv` to the returned object (after `mode,`):

```ts
  return {
    environment,
    baseUrls: { ...BASE_URLS[environment] },
    maxResponseBytes: Number(env.MAX_RESPONSE_BYTES ?? 25_000),
    port: Number(env.PORT ?? 8080),
    searchLimitDefault: Number(env.SEARCH_LIMIT_DEFAULT ?? 5),
    mode,
    transport,
    tokenEnv,
  };
```

- [ ] **Step 4: Update the five `EnvConfig` literals so the typecheck passes**

The type now requires `transport` and `tokenEnv` on every literal. In each of the five sites below, add the two lines after `mode: …,`:

**`src/app.test.ts`** — first literal (inside `testApp()`, ~line 21):
```ts
      mode: "gateway",
      transport: "http",
      tokenEnv: "GREENNODE_MCP_TOKEN",
```
Second literal (the flat-mode boot test, ~line 67):
```ts
        mode: "flat",
        transport: "http",
        tokenEnv: "GREENNODE_MCP_TOKEN",
```

**`src/server.test.ts`** (~line 38):
```ts
      mode: "gateway",
      transport: "http",
      tokenEnv: "GREENNODE_MCP_TOKEN",
```

**`src/server-flat.test.ts`** (~line 55):
```ts
      mode: "flat" as const,
      transport: "http" as const,
      tokenEnv: "GREENNODE_MCP_TOKEN",
```

**`src/meta-tools/handlers.test.ts`** (~line 43):
```ts
      mode: "gateway",
      transport: "http",
      tokenEnv: "GREENNODE_MCP_TOKEN",
```

- [ ] **Step 5: Run the env tests and the full typecheck + suite**

Run: `npx vitest run src/config/env.test.ts`
Expected: PASS (all env tests green).

Run: `npm run build && npm test`
Expected: `tsc --noEmit` passes with no errors; full vitest suite green.

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts src/app.test.ts src/server.test.ts src/server-flat.test.ts src/meta-tools/handlers.test.ts
git commit -m "feat: add TRANSPORT + TOKEN_ENV to EnvConfig (default stdio)"
```

---

### Task 2: Add `authenticateFromEnv`

**Files:**
- Modify: `src/auth/inbound.ts`
- Modify: `src/auth/inbound.test.ts`

**Interfaces:**
- Produces: `authenticateFromEnv(env: NodeJS.ProcessEnv, tokenEnv: string): AuthContext` — reads `env[tokenEnv]`, throws `AuthError` (status 401, `"missing upstream token"`) when missing or empty. Consumed by Task 4 (`index.ts`).
- Consumes: `AuthContext`, `AuthError` (already defined in this file).

- [ ] **Step 1: Write the failing tests in `src/auth/inbound.test.ts`**

Update the import to include `authenticateFromEnv`:

```ts
import { authenticate, authenticateFromEnv, AuthError } from "./inbound.js";
```

Add a new `describe` block after the existing one:

```ts
describe("authenticateFromEnv", () => {
  it("returns the token from the named env var", () => {
    const ctx = authenticateFromEnv({ GREENNODE_MCP_TOKEN: "ABC" }, "GREENNODE_MCP_TOKEN");
    expect(ctx.bearerToken).toBe("ABC");
  });

  it("honors a custom TOKEN_ENV name", () => {
    const ctx = authenticateFromEnv({ MY_TOKEN: "XYZ" }, "MY_TOKEN");
    expect(ctx.bearerToken).toBe("XYZ");
  });

  it("throws 401 'missing upstream token' when the var is missing", () => {
    try {
      authenticateFromEnv({}, "GREENNODE_MCP_TOKEN");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as AuthError).status).toBe(401);
      expect((e as AuthError).message).toMatch(/missing upstream token/i);
    }
  });

  it("throws 401 when the var is empty", () => {
    try {
      authenticateFromEnv({ GREENNODE_MCP_TOKEN: "" }, "GREENNODE_MCP_TOKEN");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as AuthError).status).toBe(401);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/auth/inbound.test.ts`
Expected: FAIL — `authenticateFromEnv` is not exported.

- [ ] **Step 3: Implement in `src/auth/inbound.ts`**

Add this function after the existing `authenticate`:

```ts
export function authenticateFromEnv(
  env: NodeJS.ProcessEnv,
  tokenEnv: string,
): AuthContext {
  const raw = env[tokenEnv];
  if (!raw) {
    throw new AuthError(401, "missing upstream token");
  }
  return { bearerToken: raw };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/auth/inbound.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/inbound.ts src/auth/inbound.test.ts
git commit -m "feat: add authenticateFromEnv for stdio token source"
```

---

### Task 3: Extract `buildServer` helper in `app.ts`

**Files:**
- Modify: `src/app.ts`
- Modify: `src/app.test.ts`

**Interfaces:**
- Produces: `buildServer(deps: AppDeps, auth: AuthContext): McpServer | Server` — selects `createFlatMcpServer` when `deps.config.mode === "flat"`, else `createMcpServer`. Consumed by `createApp` (this task) and Task 4 (`index.ts`).
- Consumes: `AppDeps` (from `app.ts`), `createMcpServer` (`server.ts`), `createFlatMcpServer` (`server-flat.ts`), `AuthContext` (`auth/inbound.ts`).

- [ ] **Step 1: Write the failing test in `src/app.test.ts`**

Add imports at the top (alongside the existing ones):

```ts
import { buildServer } from "./app.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Bm25SearchEngine } from "./search/engine.js";
import { RegistryStore } from "./registry/loader.js";
import type { Registry } from "./registry/types.js";
```

(If `Bm25SearchEngine`, `RegistryStore`, or `Registry` are already imported, do not duplicate them.)

Add a new `describe` block. It uses the empty registry that already exists in the file; if `reg` is not in scope at the point you add this, reuse the existing `reg` constant declared at module top (`const reg: Registry = { operations: [] };`).

```ts
describe("buildServer", () => {
  const baseDeps = (mode: "gateway" | "flat") => {
    const store = RegistryStore.fromObject({ operations: [] });
    return {
      registry: store,
      engine: new Bm25SearchEngine(store.all(), 5),
      config: {
        environment: "dev" as const,
        baseUrls: {},
        maxResponseBytes: 25_000,
        port: 8080,
        searchLimitDefault: 5,
        mode,
        transport: "stdio" as const,
        tokenEnv: "GREENNODE_MCP_TOKEN",
      },
    };
  };

  it("returns a gateway McpServer when mode is gateway", () => {
    const server = buildServer(baseDeps("gateway"), { bearerToken: "T" });
    expect(server).toBeInstanceOf(McpServer);
    expect(server).not.toBeInstanceOf(Server);
  });

  it("returns a low-level Server when mode is flat", () => {
    const server = buildServer(baseDeps("flat"), { bearerToken: "T" });
    expect(server).toBeInstanceOf(Server);
    expect(server).not.toBeInstanceOf(McpServer);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app.test.ts`
Expected: FAIL — `buildServer` is not exported.

- [ ] **Step 3: Implement `buildServer` and refactor `createApp` in `src/app.ts`**

Add `buildServer` below the `AppDeps` interface (and above `createApp`):

```ts
export function buildServer(
  deps: AppDeps,
  auth: AuthContext,
) {
  return deps.config.mode === "flat"
    ? createFlatMcpServer(
        {
          registry: deps.registry,
          config: deps.config,
          fetchImpl: deps.fetchImpl,
        },
        auth,
      )
    : createMcpServer(deps, auth);
}
```

Then, in `createApp`, replace the inline selection:

```ts
    // Stateless: one server + transport per request.
    const server =
      deps.config.mode === "flat"
        ? createFlatMcpServer(deps, auth)
        : createMcpServer(deps, auth);
```

with:

```ts
    // Stateless: one server + transport per request.
    const server = buildServer(deps, auth);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app.test.ts`
Expected: PASS — both `buildServer` tests green, and the existing `createApp auth gate` tests still green.

Run: `npm run build && npm test`
Expected: full typecheck + suite green (the refactor must not break `server.test.ts` / `server-flat.test.ts` / `handlers.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/app.ts src/app.test.ts
git commit -m "refactor: extract buildServer helper for transport-agnostic server selection"
```

---

### Task 4: Branch `index.ts` on `TRANSPORT` (stdio + http)

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `loadEnvConfig` (Task 1), `authenticateFromEnv` (Task 2), `buildServer` (Task 3), `StdioServerTransport` (SDK), `createApp` (existing).
- Produces: a process that either listens on `config.port` (http) or speaks MCP over stdin/stdout (stdio).

- [ ] **Step 1: Replace `src/index.ts` with the branched version**

```ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "./config/env.js";
import { RegistryStore } from "./registry/loader.js";
import { Bm25SearchEngine } from "./search/engine.js";
import { createApp, buildServer } from "./app.js";
import { authenticateFromEnv } from "./auth/inbound.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const config = loadEnvConfig(process.env);
const registry = RegistryStore.fromFile(
  join(HERE, "..", "registry.generated.json"),
);
const engine = new Bm25SearchEngine(registry.all(), config.searchLimitDefault);

if (config.transport === "http") {
  const app = createApp({ registry, engine, config });
  app.listen(config.port, () => {
    console.error(
      `greennode-agentbase-mcp listening on :${config.port} (env=${config.environment}, mode=${config.mode})`,
    );
  });
} else {
  // stdio: one long-lived server for the process lifetime. All diagnostics
  // go to stderr — stdout is the JSON-RPC protocol.
  let auth;
  try {
    auth = authenticateFromEnv(process.env, config.tokenEnv);
  } catch (e) {
    console.error(`startup failed: ${(e as Error).message}`);
    process.exit(1);
  }

  const server = buildServer({ registry, engine, config }, auth);
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    server.close();
  };
  server.connect(transport).catch((e) => {
    console.error(`server connect failed: ${(e as Error).message}`);
    process.exit(1);
  });
  console.error(
    `greennode-agentbase-mcp stdio (env=${config.environment}, mode=${config.mode})`,
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: `tsc --noEmit` passes with no errors.

- [ ] **Step 3: Smoke-check the http branch still boots (regression)**

Run:
```bash
TRANSPORT=http PORT=8095 npx tsx src/index.ts > /tmp/http.log 2>&1 &
sleep 2
cat /tmp/http.log
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8095/health
pkill -f "tsx src/index.ts"
```
Expected: the log line `greennode-agentbase-mcp listening on :8095 (env=dev, mode=gateway)` on stderr; `curl` returns `200`.

- [ ] **Step 4: Commit (tests for the branch are in Task 5)**

```bash
git add src/index.ts
git commit -m "feat: branch index.ts on TRANSPORT (stdio default, http opt-in)"
```

---

### Task 5: stdio spawn-the-process smoke tests

**Files:**
- Create: `src/stdio.smoke.test.ts`

**Interfaces:**
- Consumes: the built `src/index.ts` (spawned as a subprocess with `tsx`); `TRANSPORT`, `MODE`, `GREENNODE_MCP_TOKEN` env vars; the real `registry.generated.json` (so flat mode lists 116 tools, gateway lists 3).

- [ ] **Step 1: Write the smoke tests in `src/stdio.smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const tsx = resolve("node_modules/.bin/tsx");
const index = resolve("src/index.ts");

function runStdio(env: NodeJS.ProcessEnv, stdin = "") {
  return spawnSync(tsx, [index], {
    input: stdin,
    env: { ...process.env, ...env },
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
    const res = runStdio({ TRANSPORT: "stdio" }); // no GREENNODE_MCP_TOKEN
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/token/i);
  });

  it("lists 3 tools in gateway mode over stdio", () => {
    const res = runStdio(
      { TRANSPORT: "stdio", MODE: "gateway", GREENNODE_MCP_TOKEN: "T" },
      `${INIT}\n${LIST}\n`,
    );
    expect(res.status).toBe(0);
    expect(parseToolsList(res.stdout)).toHaveLength(3);
  });

  it("lists 116 tools in flat mode over stdio", () => {
    const res = runStdio(
      { TRANSPORT: "stdio", MODE: "flat", GREENNODE_MCP_TOKEN: "T" },
      `${INIT}\n${LIST}\n`,
    );
    expect(res.status).toBe(0);
    expect(parseToolsList(res.stdout)).toHaveLength(116);
  });
});
```

- [ ] **Step 2: Run the smoke tests**

Run: `npx vitest run src/stdio.smoke.test.ts`
Expected: PASS — three tests green. If the gateway/flat tests time out (`res.status` is `null`), the process is hanging on stdin EOF; confirm `transport.onclose` fires `server.close()` (it does, from Task 4) and re-run. If `res.status` is `0` but the tool count is wrong, inspect `res.stdout` and `res.stderr`.

- [ ] **Step 3: Run the full suite + typecheck**

Run: `npm run build && npm test`
Expected: everything green, including the new smoke tests and all pre-existing tests.

- [ ] **Step 4: Commit**

```bash
git add src/stdio.smoke.test.ts
git commit -m "test: stdio spawn smoke tests (missing token, gateway, flat)"
```

---

## Self-Review

**1. Spec coverage:**
- *`TRANSPORT` env var, default `stdio`, rejects invalid* → Task 1. ✅
- *`TOKEN_ENV` env var, default `GREENNODE_MCP_TOKEN`* → Task 1. ✅
- *`authenticateFromEnv(env, tokenEnv)` → `AuthContext`, throws `AuthError` 401 missing/empty* → Task 2. ✅
- *`buildServer(deps, auth)` extracted; `createApp` uses it; `MODE` works under both transports* → Task 3. ✅
- *`index.ts` branches: http = `createApp`+`listen`; stdio = `authenticateFromEnv` once → `buildServer` once → `StdioServerTransport` → `server.connect`* → Task 4. ✅
- *Missing token → stderr + exit(1) before connecting* → Task 4. ✅
- *stdout discipline — all logging to stderr; `console.log` → `console.error`* → Task 4. ✅
- *Server builders / handlers / downstream / projection / registry / search untouched* → no task touches them. ✅
- *`env.test.ts` TRANSPORT + TOKEN_ENV* → Task 1. ✅
- *`auth/inbound.test.ts` authenticateFromEnv* → Task 2. ✅
- *`app.test.ts` buildServer* → Task 3. ✅
- *Smoke: missing token non-zero; gateway 3 tools; flat 116 tools* → Task 5. ✅
- *Existing tests stay green; `EnvConfig` literal updates* → Task 1 Step 4 covers all five literals. ✅
- *Migration note (HTTP runtimes set `TRANSPORT=http`)* → noted in Global Constraints; the spec already carries it. ✅

**2. Placeholder scan:** No "TBD"/"TODO"/"handle edge cases". Every code step shows full code. The one conditional in Task 5 Step 2 ("If the tests time out…") is a diagnostic hint with the fix already in place, not a placeholder. ✅

**3. Type consistency:** `EnvConfig.transport: "stdio" | "http"` (Task 1) is used as `config.transport === "http"` (Task 4) — matches. `EnvConfig.tokenEnv: string` (Task 1) → `authenticateFromEnv(process.env, config.tokenEnv)` (Task 4) — matches. `authenticateFromEnv(env, tokenEnv)` signature (Task 2) matches the call in Task 4. `buildServer(deps, auth)` (Task 3) matches the call in Task 4. The `transport: "http" as const` / `"stdio" as const` literals in Task 3's test match the `Transport` union. The five literal-update sites (Task 1 Step 4) all add exactly `transport` + `tokenEnv`. ✅
