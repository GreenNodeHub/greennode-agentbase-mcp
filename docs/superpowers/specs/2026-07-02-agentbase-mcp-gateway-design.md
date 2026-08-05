# greennode-agentbase-mcp — Dynamic Meta-Tool Gateway

**Date:** 2026-07-02
**Status:** Approved design, pre-implementation

> **Update (2026-07-06):** the `environment` / `dev` dimension described below was removed — the server is prod-only now. The flat variant referenced in "Background" is also gone (the benchmark showed the gateway wins on token cost). The meta-tool gateway design itself stands.

## Problem

We are wrapping six GreenNode AgentBase REST services as an MCP server:

| Service  | Operations | Natural tag groups                                                        |
|----------|-----------:|---------------------------------------------------------------------------|
| policy   |         11 | policy-groups, policies                                                   |
| cr       |         13 | Admin, Registry Credential, Artifact, Image, Repository                   |
| gateway  |         17 | gateways, access-logs, flavors, mcp-connectors, mcp-server-templates      |
| identity |         30 | OAuth2, API Key, Delegated API Key, Agent Identity, Managed OAuth2        |
| memory   |         16 | memory-controller                                                         |
| runtime  |         29 | agent-runtime, open-claw, traces, flavor                                  |
| **Total**|    **116** | ~20 logical groups                                                        |

Raw swagger totals ~249 KB. Naively flattening to 116 MCP tools with full JSON
schemas would load an estimated **40–60K tokens** of tool definitions into the
model's context every session — the "MCP tax" this design exists to cut.

### Spec sources

| Service  | Dev spec URL                                                                    | Prod base                                   |
|----------|---------------------------------------------------------------------------------|---------------------------------------------|
| policy   | `https://agentbase.api-dev.vngcloud.tech/policy/swagger/doc.json`               | `https://agentbase.api.vngcloud.vn/policy`  |
| cr       | `https://agentbase.api-dev.vngcloud.tech/cr/swagger/doc.json`                   | `https://agentbase.api.vngcloud.vn/cr`      |
| gateway  | `https://agentbase.api-dev.vngcloud.tech/gateway/swagger/doc.json`              | `https://agentbase.api.vngcloud.vn/gateway` |
| identity | `https://agentbase.api-dev.vngcloud.tech/identity/api-docs`                     | `https://agentbase.api.vngcloud.vn/identity`|
| memory   | `https://pub-iamapis.api-dev.vngcloud.tech/agent-core-memory/v3/api-docs`       | `https://agentbase.api.vngcloud.vn/memory`  |
| runtime  | `https://pub-iamapis.api-dev.vngcloud.tech/agent-core-runtime/v3/api-docs`      | `https://agentbase.api.vngcloud.vn/runtime` |

Dev base URLs for memory/runtime differ from the others
(`pub-iamapis.api-dev.vngcloud.tech/agent-core-*`); prod consolidates all six
under `agentbase.api.vngcloud.vn/<service>`.

## Chosen approach: dynamic meta-tool gateway

Instead of exposing 116 tools, the server exposes **3 meta-tools**. The 116
operations live in an internal registry that the model searches on demand. This
cuts resident tool-definition tax by ~95%+ at the cost of one discovery
round-trip per task.

### Two layers

```
┌─────────────────────────────────────────────────────────┐
│  Generated layer  (from swagger, wholesale, committed)   │
│    registry.generated.json                               │
│      116 operations: { id, service, method, path,        │
│                        summary, tags, inputSchema }       │
└─────────────────────────────────────────────────────────┘
                          ▲ consumed by
┌─────────────────────────────────────────────────────────┐
│  Meta / filtering layer  (hand-written, TypeScript)      │
│    • 3 meta-tools: list_servers, search_tools, execute   │
│    • BM25 SearchEngine  (pluggable → hybrid later)       │
│    • response field-selector + byte cap                  │
│    • auth pass-through + inbound api-key guard           │
│    • env resolver (ENV=dev|prod → base URLs)             │
└─────────────────────────────────────────────────────────┘
        Remote MCP server (Streamable HTTP), behind gateway
```

- **Generated layer** — the registry of all 116 operations, extracted straight
  from swagger, regenerated wholesale when specs change. Never hand-edited.
- **Meta / filtering layer** — the hand-written framework we keep and fine-tune.
  It *consumes* the generated registry. No per-operation annotation overlay;
  tuning lives in this layer's logic.

## Meta-tools (the only tools the model sees)

### `list_servers()`
Returns orientation for the 6 services:
`[{ name, description, operationCount, tags }]`.

### `search_tools(query, server?, limit=5)`
BM25-ranked matches. Each result is **rich** — full input schema inline (2-step
discovery: search → execute, no separate describe step):
`[{ id, service, summary, inputSchema }]`.
- `server` (optional) scopes search to one service.
- `limit` (default 5) caps result count to bound token cost.

### `execute(id, args, fields?)`
Runs the real HTTP call for operation `id`:
1. Verify inbound api-key; assert downstream bearer token present.
2. Resolve service base URL from `ENV`.
3. Bind `args` to the operation's method/path/query/body.
4. Forward `Authorization: Bearer <token>` (from request context).
5. Apply optional `fields` projection to the response.
6. Enforce byte cap; truncate with notice if exceeded.

Operation ids are namespaced `service.operationId`
(e.g. `runtime.createAgentRuntime`).

### Example flow

```
model: search_tools("spin up an agent runtime", server:"runtime")
  → [{ id:"runtime.createAgentRuntime", summary, inputSchema:{...} }, ...≤5]
model: execute("runtime.createAgentRuntime", { <args> }, fields:"id,name,status")
  → verify api-key → bearer from ctx → POST <prod>/runtime/... 
    → project fields → cap bytes → return
```

## Search — BM25 now, pluggable

A `SearchEngine` interface with a `Bm25Engine` implementation. Index fields:
`name + summary + tags + path`, across all 116 ops, built once at boot from the
registry. Deterministic, no external dependencies.

**Future:** swap in a hybrid engine (BM25 + curated per-service aliases) if
accuracy proves insufficient. This is a drop-in behind the `SearchEngine`
interface — the meta-tool contract does not change.

## Response filtering

- `execute`'s optional `fields` param projects the response (JSONPath/jq-style).
  Default (omitted) returns the full response.
- A global **max-response-bytes cap** always applies. On overflow: truncate and
  append `[truncated — narrow with fields/pagination]`.
- The API's own pagination params pass through as ordinary `args`.
- The field-selector default behavior lives in the tunable meta-layer, so
  per-operation default projections can be added later without changing the
  contract.

## Auth & environment

**Deployment context:** this server runs behind an MCP gateway service that
already performs credential→token exchange. This server does not manage service
credentials or run any OAuth2 flow.

- **Inbound:** verify an api-key on every request **and** assert a downstream
  bearer token is present in the request context. If the token is missing →
  `401 missing upstream token` (fail fast; no silent unauthenticated downstream
  calls).
- **Downstream:** forward the same bearer token as `Authorization: Bearer <T>`
  to any service. One token is valid across all six services; no per-service
  auth branching. (Kept simple deliberately; if audiences ever diverge, a
  per-service auth resolver can be introduced in the meta-layer.)
- **Environment:** `ENV=dev|prod` chosen at startup binds all services to that
  environment's base URLs. One deployment per environment.

The `spec_auth` field in the source config (`per_operation` vs
`implicit_oauth2`) describes how each service authenticates in isolation, but
collapses to uniform token pass-through at this layer because the gateway owns
credential handling.

## Registry generation (build-time)

`scripts/generate-registry.ts`:
1. Read/fetch the 6 swagger specs.
2. Flatten `paths × methods` into 116 registry entries.
3. Resolve/inline each operation's input schema (path + query + body params).
4. Write `registry.generated.json` (committed, never hand-edited).

This build step is the seam the future auto-generator plugs into. Runtime never
depends on live spec endpoints.

## Token math

- Flat 116 tools: ~40–60K tokens resident every session.
- This gateway: 3 tool definitions ≈ ~1–2K tokens resident, plus ~one
  `search_tools` result (≤5 schemas) per task on demand.
- Net: **~95%+ reduction** in resident tool-definition tax.

## Project structure

```
src/
  index.ts               # HTTP MCP server bootstrap (Streamable HTTP)
  meta-tools/            # list_servers, search_tools, execute
  search/                # SearchEngine interface + Bm25Engine
  filter/                # response field selector + byte cap
  auth/                  # inbound api-key guard + token pass-through
  registry/              # loader + types (reads registry.generated.json)
  config/                # ENV → base URL resolution
scripts/
  generate-registry.ts   # build-time: specs → registry.generated.json
registry.generated.json  # committed generated artifact
```

## Non-goals

- No local stdio transport (remote HTTP only, behind the gateway).
- No credential/OAuth2 management in this server (the gateway owns it).
- No hand-editing of the generated registry.
- No embedding/semantic search in v1 (BM25 only, pluggable later).
- No per-service token handling in v1 (single forwarded token).

## Decisions log

| Decision                        | Choice                                              |
|---------------------------------|-----------------------------------------------------|
| Build model                     | Generated scaffold + hand-tuned meta layer          |
| Tool exposure                   | Dynamic meta-tool gateway (3 tools)                 |
| Discovery flow                  | 2-step: rich search (schema inline) → execute       |
| Search engine                   | BM25 now, pluggable to hybrid later                 |
| Response filtering              | Optional `fields` selector + hard byte cap          |
| Inbound auth                    | api-key verification + require bearer present        |
| Downstream auth                 | Forward one bearer token to all services            |
| Environment                     | `ENV=dev\|prod` selected at startup                 |
| Stack                           | TypeScript / Node                                   |
| Registry                        | Build-time generated artifact, committed            |
