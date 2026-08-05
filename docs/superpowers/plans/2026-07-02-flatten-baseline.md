# Flatten + No-Filtering Baseline Implementation Plan

> **SUPERSEDED (2026-07-06):** the flat variant was removed. See `benchmarks/report-2026-07-06.md` — the gateway won the token-cost benchmark, so flat was a throwaway comparison. This plan is retained as a historical record.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second MCP server variant (`MODE=flat`) that exposes all 116 operations as individual tools with raw responses and no filtering, for token-cost comparison against the meta-tool gateway variant.

**Architecture:** Both variants live in one codebase, selected at runtime by a `MODE` env var. The flat variant uses the SDK's low-level `Server` class (not `McpServer`) so each operation's raw JSON Schema `inputSchema` can be returned verbatim from `tools/list` with no Zod conversion. It registers `ListToolsRequestSchema` and `CallToolRequestSchema` handlers over a `Map<toolName, RegistryOperation>`, dispatches each call to the existing `callDownstream`, and returns the raw body. All shared infrastructure (registry loader, `callDownstream`, bearer-only auth, Streamable HTTP transport with `sessionIdGenerator: undefined`) is reused unchanged.

**Tech Stack:** TypeScript, Node 20, `@modelcontextprotocol/sdk` (low-level `Server` + `ListToolsRequestSchema`/`CallToolRequestSchema` from `types.js`), `vitest`, Express, `zod` (only as consumed by the SDK schemas).

## Global Constraints

- Branch is `experiment/flatten-baseline` (already created off `dev`); commit each task on this branch.
- The gateway variant must keep working unchanged: `MODE` defaults to `"gateway"`, and when unset the existing `createMcpServer` path runs exactly as before.
- Flat variant returns **raw response bodies** — no JMESPath projection, no `maxResponseBytes` cap. Pure naive baseline by explicit decision.
- `MODE` accepts only `"gateway"` or `"flat"`; any other value throws at config load (fail-fast at boot, never silently).
- MCP tool names must match `^[a-zA-Z0-9_-]{1,64}$`. Operation ids contain dots; derive names via the rule in Task 1. Verified: 116 ops are character-valid + collision-free after conversion; 3 exceed 64 chars and need the hash fallback.
- Tool dispatch keys off a `Map<toolName, RegistryOperation>` built at construction — never parse the name back into an id.
- Do not modify the BM25 search engine or JMESPath projector; they stay in-tree, simply unreferenced by the flat path.
- No new runtime dependencies. Reuse `callDownstream`, `RegistryStore`, `authenticate`, `StreamableHTTPServerTransport`, `createHash` from `node:crypto`.
- TDD: write the failing test first, run it to see it fail, implement, run to see it pass, then commit. Run the full suite before each commit to ensure no regressions.
- Test command: `npm test` (runs `vitest run`). Typecheck/build: `npm run build`.

---

## File Structure

- **Create `src/server-flat.ts`** — the flat-variant server builder. Owns tool-name derivation, the `ListToolsRequestSchema`/`CallToolRequestSchema` handlers, and raw-body dispatch. One responsibility: turn the registry into 116 tools.
- **Create `src/server-flat.test.ts`** — in-memory transport round-trip tests for the flat variant, mirroring `src/server.test.ts`.
- **Modify `src/config/env.ts`** — add `mode: "gateway" | "flat"` to `EnvConfig` and parse `MODE` in `loadEnvConfig`.
- **Modify `src/config/env.test.ts`** — assert `MODE` default and rejection of invalid values.
- **Modify `src/app.ts`** — select `createFlatMcpServer` vs `createMcpServer` by `config.mode`; widen the server builder's return type so both `McpServer` and the low-level `Server` satisfy it.

---

## Task 1: Tool-name derivation + low-level flat server builder

This task delivers the flat server in isolation (a pure builder returning a low-level `Server`) with its own test, before any wiring into `createApp`. The wiring comes in Task 2.

**Files:**
- Create: `src/server-flat.ts`
- Test: `src/server-flat.test.ts`

**Interfaces:**
- Consumes (from existing code, unchanged):
  - `RegistryStore` from `./registry/loader.js` — `store.all(): RegistryOperation[]`
  - `RegistryOperation` from `./registry/types.js` — fields: `id: string`, `service: string`, `operationId: string`, `method: string`, `path: string`, `summary: string`, `tags: string[]`, `parameters: ParamSpec[]`, `hasBody: boolean`, `bodyRequired: boolean`, `inputSchema: JsonSchema` (a `Record<string, any>`)
  - `callDownstream(req: DownstreamRequest, fetchImpl?: FetchLike): Promise<{ status: number; body: unknown }>` from `./http/downstream.js`, where `DownstreamRequest = { op: RegistryOperation; args: Record<string, any>; baseUrl: string; bearerToken: string }`
  - `AuthContext` from `./auth/inbound.js` — `{ bearerToken: string }`
  - `EnvConfig` from `./config/env.js` — has `baseUrls: Record<string, string>` (this task reads `baseUrls[op.service]`)
  - SDK: `Server` from `@modelcontextprotocol/sdk/server/index.js`; `ListToolsRequestSchema`, `CallToolRequestSchema` from `@modelcontextprotocol/sdk/types.js`
- Produces (used by Task 2's wiring):
  - `export function createFlatMcpServer(deps: FlatServerDeps, auth: AuthContext): Server`
  - where `FlatServerDeps = { registry: RegistryStore; config: EnvConfig; fetchImpl?: FetchLike }`
  - The returned `Server` is a low-level `Server` with `.connect(transport)` and `.close()` (via the `Protocol` base class) — same interface `createApp` already calls.

### Tool-name derivation rule (implemented in this task)

```
function flatToolName(id: string): string
  base = id.replace(/\./g, "__")            // dots -> double underscore
  if base.length <= 64: return base
  hash = createHash("sha256").update(id).digest("hex").slice(0, 8)
  return base.slice(0, 55) + "_" + hash      // 55 + 1 + 8 = 64, fits the limit
```

The full `id` is hashed (not `base`), so the fallback is deterministic and stable across boots.

- [ ] **Step 1: Write the failing test**

Create `src/server-flat.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFlatMcpServer } from "./server-flat.js";
import { RegistryStore } from "./registry/loader.js";
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

function deps(fetchImpl?: any) {
  const store = RegistryStore.fromObject(reg);
  return {
    registry: store,
    config: {
      environment: "dev" as const,
      baseUrls: { runtime: "https://h/runtime" },
      maxResponseBytes: 25_000,
      port: 8080,
      searchLimitDefault: 5,
    },
    fetchImpl,
  };
}

describe("createFlatMcpServer", () => {
  it("exposes one tool per operation with its raw inputSchema", async () => {
    const server = createFlatMcpServer(deps(), { bearerToken: "TKN" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["runtime__getAgentRuntime", "runtime__listAgentRuntimes"]);

    const get = tools.tools.find((t) => t.name === "runtime__getAgentRuntime")!;
    expect(get.inputSchema).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
  });

  it("dispatches a tool call to callDownstream and returns the raw body", async () => {
    const cap: any = {};
    const fetchImpl = async (url: string, init: any) => {
      cap.url = url;
      cap.auth = init.headers.Authorization;
      return {
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ id: "r1", status: "RUNNING" }),
      };
    };
    const server = createFlatMcpServer(deps(fetchImpl), { bearerToken: "TKN" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const result = await client.callTool({
      name: "runtime__getAgentRuntime",
      arguments: { id: "r1" },
    });
    expect(cap.url).toBe("https://h/runtime/v3/agent-runtimes/r1");
    expect(cap.auth).toBe("Bearer TKN");
    // Raw body, unprojected:
    expect(JSON.parse((result.content as any)[0].text)).toEqual({
      id: "r1",
      status: "RUNNING",
    });
  });

  it("returns an error result for an unknown tool name", async () => {
    const server = createFlatMcpServer(deps(), { bearerToken: "TKN" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const result = await client.callTool({ name: "nope__nope", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toMatch(/unknown tool/i);
  });

  it("marks a downstream 4xx as an error result with the raw body", async () => {
    const fetchImpl = async () => ({
      status: 404,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ error: "not found" }),
    });
    const server = createFlatMcpServer(deps(fetchImpl), { bearerToken: "TKN" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const result = await client.callTool({
      name: "runtime__getAgentRuntime",
      arguments: { id: "missing" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as any)[0].text)).toEqual({ error: "not found" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server-flat.test.ts`
Expected: FAIL — `createFlatMcpServer` is not defined (module `./server-flat.js` does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/server-flat.ts`:

```typescript
import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { RegistryStore } from "./registry/loader.js";
import type { RegistryOperation } from "./registry/types.js";
import type { EnvConfig } from "./config/env.js";
import { callDownstream, type FetchLike } from "./http/downstream.js";
import type { AuthContext } from "./auth/inbound.js";

export interface FlatServerDeps {
  registry: RegistryStore;
  config: EnvConfig;
  fetchImpl?: FetchLike;
}

/**
 * Derive a spec-compliant MCP tool name (^[a-zA-Z0-9_-]{1,64}$) from an
 * operation id ("<service>.<operationId>"). Dots become "__"; ids longer
 * than 64 chars after conversion use a 55-char prefix + 8-char sha256 hash
 * of the full id. The full id (not the converted base) is hashed so the
 * fallback is deterministic and stable across boots.
 */
export function flatToolName(id: string): string {
  const base = id.replace(/\./g, "__");
  if (base.length <= 64) return base;
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 8);
  return base.slice(0, 55) + "_" + hash;
}

function descriptionFor(op: RegistryOperation): string {
  const methodPath = `${op.method} ${op.path}`;
  return op.summary ? `${op.summary} — ${methodPath}` : methodPath;
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    isError: isError || undefined,
  };
}

export function createFlatMcpServer(
  deps: FlatServerDeps,
  auth: AuthContext,
): Server {
  const server = new Server(
    { name: "greennode-agentbase-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // name -> op, built once at construction. Dispatch never parses names back.
  const byName = new Map<string, RegistryOperation>();
  const toolList = deps.registry.all().map((op) => {
    const name = flatToolName(op.id);
    byName.set(name, op);
    return {
      name,
      description: descriptionFor(op),
      inputSchema: op.inputSchema,
    };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolList,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const op = byName.get(name);
    if (!op) {
      return textResult(`unknown tool: ${name}`, true);
    }

    const baseUrl = deps.config.baseUrls[op.service];
    if (!baseUrl) {
      return textResult(`no base URL for service: ${op.service}`, true);
    }

    try {
      const res = await callDownstream(
        {
          op,
          args: request.params.arguments ?? {},
          baseUrl,
          bearerToken: auth.bearerToken,
        },
        deps.fetchImpl,
      );
      const bodyText =
        typeof res.body === "string" ? res.body : JSON.stringify(res.body);
      return textResult(bodyText, res.status >= 400);
    } catch (e) {
      return textResult(`downstream call failed: ${(e as Error).message}`, true);
    }
  });

  return server;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/server-flat.test.ts`
Expected: PASS — all 4 tests green.

If the `tools/list` call returns no tools (empty list), the `capabilities: { tools: {} }` declaration is required and is shown above; do not remove it. If a different capability shape is needed, the test failure will name it — fix the capability object, not the test.

- [ ] **Step 5: Run the full suite to ensure no regressions**

Run: `npm test`
Expected: all 12 existing files pass + the new `server-flat.test.ts` (4 tests). No regressions.

- [ ] **Step 6: Typecheck/build**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/server-flat.ts src/server-flat.test.ts
git commit -m "feat: flat MCP server variant (116 tools, raw responses)"
```

---

## Task 2: MODE config + createApp wiring

Wire the flat server into the app behind a `MODE` env var, defaulting to `gateway` so the deployed gateway endpoint keeps behaving exactly as before.

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/config/env.test.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: `createFlatMcpServer(deps: FlatServerDeps, auth: AuthContext): Server` from `./server-flat.js` (Task 1); `createMcpServer(deps: ServerDeps, auth: AuthContext): McpServer` from `./server.js` (existing).
- Produces: `EnvConfig.mode: "gateway" | "flat"` (read by `createApp`); `createApp` now selects the builder by `config.mode`. Both builders' return values satisfy the structural `{ connect(transport): Promise<void>; close(): Promise<void> }` that the `/mcp` handler calls.

### Task 2a: `MODE` in config

- [ ] **Step 1: Write the failing test (append to `src/config/env.test.ts`)**

Add these two tests inside the existing `describe("loadEnvConfig", ...)` block in `src/config/env.test.ts`:

```typescript
  it("defaults MODE to gateway", () => {
    const cfg = loadEnvConfig(base);
    expect(cfg.mode).toBe("gateway");
  });

  it("accepts MODE=flat and rejects other values", () => {
    expect(loadEnvConfig({ ...base, MODE: "flat" }).mode).toBe("flat");
    expect(() => loadEnvConfig({ ...base, MODE: "bogus" })).toThrow(/MODE/);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/config/env.test.ts`
Expected: FAIL — `cfg.mode` is `undefined` (property does not exist on `EnvConfig` yet).

- [ ] **Step 3: Implement — add `mode` to `EnvConfig` and parse `MODE`**

In `src/config/env.ts`:

1. Add a `ServerMode` type and the `mode` field to the interface. Replace the `EnvConfig` interface (currently lines 33–39):

```typescript
export type ServerMode = "gateway" | "flat";

export interface EnvConfig {
  environment: Environment;
  baseUrls: Record<string, string>;
  maxResponseBytes: number;
  port: number;
  searchLimitDefault: number;
  mode: ServerMode;
}
```

2. Parse `MODE` in `loadEnvConfig`. Replace the body of `loadEnvConfig` (currently lines 41–55) with:

```typescript
export function loadEnvConfig(env: NodeJS.ProcessEnv): EnvConfig {
  const raw = env.ENV ?? "dev";
  if (raw !== "dev" && raw !== "prod") {
    throw new Error(`Invalid ENV "${raw}": expected "dev" or "prod"`);
  }
  const environment = raw as Environment;

  const modeRaw = env.MODE ?? "gateway";
  if (modeRaw !== "gateway" && modeRaw !== "flat") {
    throw new Error(
      `Invalid MODE "${modeRaw}": expected "gateway" or "flat"`,
    );
  }
  const mode = modeRaw as ServerMode;

  return {
    environment,
    baseUrls: { ...BASE_URLS[environment] },
    maxResponseBytes: Number(env.MAX_RESPONSE_BYTES ?? 25_000),
    port: Number(env.PORT ?? 8080),
    searchLimitDefault: Number(env.SEARCH_LIMIT_DEFAULT ?? 5),
    mode,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/config/env.test.ts`
Expected: PASS — all 6 env tests green (4 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts
git commit -m "feat: add MODE config (gateway|flat) to EnvConfig"
```

### Task 2b: Select the server builder in `createApp`

- [ ] **Step 1: Write the failing test (append to `src/app.test.ts`)**

Add this test to the existing `describe("createApp auth gate", ...)` block in `src/app.test.ts`:

```typescript
  it("exposes the flat tool set when MODE=flat", async () => {
    const store = RegistryStore.fromObject(reg);
    const app = createApp({
      registry: store,
      engine: new Bm25SearchEngine(store.all(), 5),
      config: {
        environment: "dev",
        baseUrls: {},
        maxResponseBytes: 25_000,
        port: 8080,
        searchLimitDefault: 5,
        mode: "flat",
      },
    });
    // The app still boots and health responds; the flat path is exercised
    // end-to-end by server-flat.test.ts. Here we assert no throw on boot
    // and that /health still works in flat mode.
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, env: "dev" });
  });
```

Note: `src/app.test.ts` already imports `RegistryStore` and `Bm25SearchEngine` and defines a `reg` constant (currently `{ operations: [] }`). With an empty registry the flat builder registers zero tools, which is fine — this test only asserts the app boots in flat mode and `/health` works. The flat tool-set behavior is covered by `server-flat.test.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app.test.ts`
Expected: FAIL — TypeScript error: `mode` is not a known property of the config literal (excess property check) AND `createApp` does not yet branch on mode. The compile failure is the failing signal.

- [ ] **Step 3: Implement — branch on `config.mode` in `createApp`**

In `src/app.ts`:

1. Add the import for the flat builder. After the existing `import { createMcpServer } from "./server.js";` line (line 8), add:

```typescript
import { createFlatMcpServer } from "./server-flat.js";
```

2. Replace the server-construction line inside the `/mcp` handler. Find this block (currently lines 36–37):

```typescript
    // Stateless: one server + transport per request.
    const server = createMcpServer(deps, auth);
```

Replace it with:

```typescript
    // Stateless: one server + transport per request.
    const server =
      deps.config.mode === "flat"
        ? createFlatMcpServer(deps, auth)
        : createMcpServer(deps, auth);
```

No other changes to `app.ts`. The existing `server.connect(transport)` / `server.close()` calls work unchanged because the low-level `Server` and `McpServer` both expose those methods. If TypeScript complains that the union type lacks `connect`/`close` (it should not, since both share the `Protocol` base), add an explicit type annotation `const server: { connect(t: any): Promise<void>; close(): Promise<void> }` — but only if the build actually errors; do not add it speculatively.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app.test.ts`
Expected: PASS — all 5 app tests green (4 existing + 1 new).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all test files green, no regressions.

- [ ] **Step 6: Typecheck/build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/app.ts src/app.test.ts
git commit -m "feat: wire MODE=flat into createApp server selection"
```

---

## Task 3: Local end-to-end smoke for both modes

A manual verification step (no new test file) confirming both variants boot locally and behave as designed, mirroring the live-endpoint check already done for the gateway. This catches integration issues a unit test won't (e.g. the low-level `Server` advertising its capability correctly to a real MCP client over HTTP).

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 2: Boot the gateway mode locally and verify 3 tools**

Run (gateway, default mode):
```bash
ENV=dev PORT=8091 npx tsx src/index.ts > /tmp/gateway.log 2>&1 &
sleep 2
curl -s -X POST http://localhost:8091/mcp \
  -H "Authorization: Bearer T" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' >/dev/null
curl -s -X POST http://localhost:8091/mcp \
  -H "Authorization: Bearer T" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | grep -o '"name":"[^"]*"' | sort
pkill -f "tsx src/index.ts"
```
Expected: exactly three tool names — `execute`, `list_servers`, `search_tools`.

- [ ] **Step 3: Boot flat mode locally and verify 116 tools**

Run (flat mode):
```bash
ENV=dev MODE=flat PORT=8092 npx tsx src/index.ts > /tmp/flat.log 2>&1 &
sleep 2
curl -s -X POST http://localhost:8092/mcp \
  -H "Authorization: Bearer T" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' >/dev/null
curl -s -X POST http://localhost:8092/mcp \
  -H "Authorization: Bearer T" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | grep -o '"name":"[^"]*"' | wc -l
pkill -f "tsx src/index.ts"
```
Expected: `116` (one tool per operation). Also confirm no tool name contains a `.`:
```bash
ENV=dev MODE=flat PORT=8093 npx tsx src/index.ts > /tmp/flat2.log 2>&1 &
sleep 2
curl -s -X POST http://localhost:8093/mcp \
  -H "Authorization: Bearer T" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' >/dev/null
curl -s -X POST http://localhost:8093/mcp \
  -H "Authorization: Bearer T" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | grep -c '\."'
pkill -f "tsx src/index.ts"
```
Expected: `0` (no dotted names leak through).

- [ ] **Step 4: Confirm invalid MODE fails fast at boot**

Run:
```bash
ENV=dev MODE=bogus PORT=8094 npx tsx src/index.ts > /tmp/badmode.log 2>&1
echo "exit: $?"
cat /tmp/badmode.log
```
Expected: the process exits non-zero with an error message matching `/Invalid MODE "bogus"/`. It must NOT start listening.

- [ ] **Step 5: No commit**

This task is verification only — no code changes, nothing to commit. If any check fails, fix the offending task before proceeding.

---

## Self-Review

**1. Spec coverage:**
- *Flat server builder using low-level `Server`, `ListToolsRequestSchema`/`CallToolRequestSchema`, raw `inputSchema` verbatim* → Task 1. ✅
- *`Map<toolName, RegistryOperation>` dispatch* → Task 1. ✅
- *Raw response body, no JMESPath, no byte cap* → Task 1 `callDownstream` → `textResult(bodyText, ...)` returns raw. ✅
- *`isError` mirrors `status >= 400`* → Task 1 handler. ✅
- *Tool-name derivation (`.`→`__`, ≤64 verbatim, >64 hash fallback)* → Task 1 `flatToolName`. ✅
- *Capabilities advertised* → Task 1 `new Server(..., { capabilities: { tools: {} } })`. ✅
- *`MODE` env var, default `gateway`, throws on invalid* → Task 2a. ✅
- *`createApp` selects builder by `config.mode`* → Task 2b. ✅
- *Gateway variant unchanged when `MODE` unset* → Task 2b (default branch is `createMcpServer`), verified by Task 3 Step 2. ✅
- *New `server-flat.test.ts`; existing tests stay green; `env.test.ts` gains MODE assertion* → Tasks 1 & 2a. ✅
- *Out of scope honored: no harness, no hardening, BM25/JMESPath untouched* → no task touches them. ✅

**2. Placeholder scan:** No "TBD"/"TODO"/"handle edge cases". Every code step shows full code. The single conditional instruction in Task 2b Step 3 ("only if the build actually errors") is a guarded fallback for a real SDK type-surface uncertainty, not a placeholder — the primary path is complete.

**3. Type consistency:** `FlatServerDeps` (Task 1) is used verbatim in Task 2b's prose. `createFlatMcpServer(deps, auth)` signature is identical in Task 1 (definition) and Task 2b (call site). `EnvConfig.mode: ServerMode` (`"gateway" | "flat"`) is consistent across Task 2a (definition), Task 2b (`deps.config.mode === "flat"`), and the test literals. `request.params.name` / `request.params.arguments` match the verified SDK contract. `callDownstream`'s `DownstreamRequest` shape (`{ op, args, baseUrl, bearerToken }`) matches the existing `src/http/downstream.ts`. ✅
