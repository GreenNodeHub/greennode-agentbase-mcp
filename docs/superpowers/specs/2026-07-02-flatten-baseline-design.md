# Flatten + No-Filtering Baseline Variant — Design

> **SUPERSEDED (2026-07-06):** the flat variant was removed from the codebase. The benchmark (`benchmarks/report-2026-07-06.md`) showed the gateway beats flat on token cost for 1–4-op sessions, so flat was a throwaway comparison, not a shipped feature. This spec is retained as a historical design record.

**Goal:** Build a naive-baseline variant of the AgentBase MCP server that exposes all 116 operations as individual MCP tools with no response filtering, so its token cost ("MCP tax") can be measured against the meta-tool gateway variant on `dev`.

## Background

The current server (branch `dev`, deployed as runtime `runtime-df392fed...` v0.1.1) is a **meta-tool gateway**: it exposes exactly 3 tools — `list_servers`, `search_tools`, `execute` — backed by a BM25 search index over the 116-operation registry, with JMESPath response projection and a byte cap. The model discovers operations via search and invokes them through the single `execute` tool.

This design adds a second, deliberately naive variant for comparison: **one MCP tool per operation, raw responses, no search, no projection.** This is the "flatten everything into the manifest" baseline that the gateway exists to avoid. The two variants will be compared by deploying each as a separate endpoint and observing token consumption in a client.

## Architecture

Both variants live in one codebase, selected at runtime by a `MODE` env var. All shared infrastructure is reused unchanged so the comparison is fair — only the tool-registration layer and response handling differ.

```
                 MODE=gateway (default)          MODE=flat (new)
                 ──────────────────────          ──────────────
createApp ─────► createMcpServer                 createFlatMcpServer
                 (high-level McpServer,          (low-level Server,
                  3 meta-tools)                   116 tools)
                 │                                │
                 ├─ list_servers                  ├─ tools/list → all 116 ops,
                 ├─ search_tools (BM25)           │    each with raw inputSchema
                 └─ execute (JMESPath + cap)      └─ tools/call → dispatch by name,
                                                   │    raw response, no projection

shared (both modes): callDownstream · registry loader · bearer-only auth ·
                      Streamable HTTP transport (sessionIdGenerator: undefined)
```

The flat path uses the SDK's **low-level `Server`** class (not the high-level `McpServer`) because the operations' `inputSchema` fields are raw JSON Schema objects, and `McpServer.registerTool` only accepts Zod schemas (`AnySchema = z3.ZodTypeAny | z4.$ZodType`). Using the low-level `Server` lets the `tools/list` handler return each operation's raw `inputSchema` verbatim — no JSON-Schema→Zod conversion, which would be heavy and lossy for the nested/`oneOf` schemas in the registry. The low-level `Server` exposes the same `connect(transport)` / `close()` interface `createApp` already calls, so the app wiring is unchanged.

The flat path does not reference the BM25 search engine or JMESPath projector. That code stays in-tree, unreferenced by the flat builder.

## Components

### `src/server-flat.ts` (new)

Exports `createFlatMcpServer(deps, auth)`, returning a low-level `Server` (from `@modelcontextprotocol/sdk/server/index.js`). At construction it builds a `Map<toolName, RegistryOperation>` over `registry.all()`, then registers two request handlers:

- **`ListToolsRequestSchema`** (from `@modelcontextprotocol/sdk/types.js`): returns one tool entry per operation. Each entry is `{ name, description, inputSchema }` where `inputSchema` is the operation's raw JSON Schema, passed through verbatim. `description` is the operation's `summary` with `<METHOD> <path>` appended (e.g. `"List agent runtimes — GET /v3/agent-runtimes"`); an empty summary uses `<METHOD> <path>` alone.
- **`CallToolRequestSchema`**: looks up the operation by `params.name` in the map (unknown name → an MCP error result), reads `baseUrl = config.baseUrls[op.service]`, calls the existing `callDownstream({ op, args: params.arguments ?? {}, baseUrl, bearerToken }, fetchImpl)`, and returns the **raw response body as text** — no JMESPath projection, no byte cap. The `isError` flag mirrors the downstream HTTP status (`>= 400` → error), matching how the gateway's `execute` reports errors but without projecting the body.

**Tool name** is derived from the operation id (see *Tool-name derivation* below) and used as the map key, so dispatch never depends on parsing the name back into an id.

**Capabilities:** the low-level `Server` must advertise the `tools` capability for `tools/list` to be honored by clients. Whether this is inferred from the registered handlers or must be declared explicitly via `registerCapabilities({ tools: {} })` will be confirmed during implementation (the in-memory transport test fails loudly if missing). Either way it is a one-line setup.

**Return-type compatibility:** `createApp` calls `server.connect(transport)` and `server.close()`, both present on the low-level `Server` (via the `Protocol` base). The app's server-builder selection will accept the union `McpServer | Server`, or a minimal structural `{ connect; close }` type, so no change to the request-handling plumbing is needed.

### `MODE` wiring (modify `src/app.ts` and `src/config/env.ts`)

- Add `mode: "gateway" | "flat"` to `EnvConfig`; `loadEnvConfig` reads `MODE` (default `"gateway"`, accepts only those two values, throws otherwise).
- In `createApp`, select the server builder: `mode === "flat" ? createFlatMcpServer : createMcpServer`. Everything else in the request handler (per-request server + transport, `sessionIdGenerator: undefined`, auth gate, `/health`) is unchanged.

### Tool-name derivation

MCP tool names must match `^[a-zA-Z0-9_-]{1,64}$`. Operation ids are `<service>.<operationId>` (dots), and the registry generator flattened long paths into operationIds, producing a few ids >64 chars after conversion. The rule:

1. Replace every `.` with `__` → `<service>__<operationId>`.
2. If the result is ≤64 chars, use it verbatim.
3. If >64 chars, use the first 55 characters + `_` + an 8-hex-char deterministic hash of the full id (e.g. `createHash("sha256")`, first 8 hex chars) → total ≤64, guaranteed unique across the registry.

Verified against the live registry (`registry.generated.json`, 116 operations): all 116 are character-valid and collision-free after conversion; **3** exceed 64 chars and hit the fallback. The `CallToolRequestSchema` handler dispatches via the `Map<toolName, op>` built at construction, so the hash fallback cannot break execution or misroute a call — the derived name is only ever a map key.

## Data flow (flat variant, single tool call)

1. Client calls tool `runtime__getAgentRuntime` with `{ id: "r1" }`.
2. Handler looks up `baseUrl = config.baseUrls["runtime"]`, calls `callDownstream({ op, args, baseUrl, bearerToken })`.
3. `callDownstream` binds path/query params, performs the HTTP request with the pass-through bearer token, returns `{ status, body }`.
4. Handler returns the raw `body` text (error flag if `status >= 400`).

No search, no projection, no capping.

## Testing

A new `src/server-flat.test.ts` mirroring the existing `src/server.test.ts` pattern: build a 2-operation registry, construct the flat server over an in-memory transport, assert:

- `tools/list` exposes exactly the 2 operations under their derived flat names.
- Each tool's `inputSchema` matches the operation's `inputSchema`.
- Calling a tool invokes `callDownstream` (via an injected fake `fetchImpl`) and returns the **raw** downstream body, unprojected.

Existing tests (`server.test.ts`, `app.test.ts`, `handlers.test.ts`, `env.test.ts`) must continue to pass. `env.test.ts` gains one assertion: `MODE` defaults to `"gateway"` and rejects invalid values.

## Out of scope

- **No measurement harness.** Comparison is done by the user, deploying each variant as a separate endpoint and observing token usage in a client. The flat variant is server-only.
- **No hardening of the baseline.** No byte cap, no pagination, no response truncation. This is the pure naive baseline by explicit decision; it can be hardened later if needed.
- **No changes to the deployed gateway endpoint.** The live `v0.1.1` gateway stays as-is; the flat variant is deployed as a *second* endpoint from this branch's image with `MODE=flat`.

## Measurement methodology (for the user)

Deploy this branch's image (`MODE=flat`) as a new runtime/endpoint alongside the existing gateway endpoint. In a client (e.g. Claude Code), add each endpoint as a separate MCP server and compare the `tools/list` manifest size loaded into context — the dominant fixed cost — plus observed per-conversation token usage. The flat manifest (116 tools) vs the gateway manifest (3 tools) is the headline "MCP tax" number the gateway is designed to avoid.
