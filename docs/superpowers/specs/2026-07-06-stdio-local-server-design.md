# Local stdio MCP Server — Design

> **Update (2026-07-06):** `MODE` (gateway|flat) and `ENV` (dev|prod) were removed after this spec was written — the server is gateway-only and prod-only now. The `TRANSPORT` (stdio|http) design here stands unchanged.

**Goal:** Add a local, agent-agnostic stdio transport to the AgentBase MCP server so any MCP-speaking client (Claude Code, Cursor, Continue, Zed, Cline, …) can run the gateway from its own machine as `TRANSPORT=stdio tsx src/index.ts` — no deployed runtime required, the upstream bearer token stays local.

## Background

The server today is HTTP-only: `index.ts` builds `createApp()` and `app.listen(port)`, and `app.ts` handles each `POST /mcp` by constructing a fresh MCP server + `StreamableHTTPServerTransport` per request, authenticating the bearer token from the `Authorization` header. This works for the deployed AgentBase runtime, but a local user has no easy way to run the gateway without standing up that runtime endpoint.

MCP defines a stdio transport that any MCP client can spawn as a subprocess and talk to over stdin/stdout. Adding it lets the gateway run locally. The SDK already ships `StdioServerTransport` (`@modelcontextprotocol/sdk/server/stdio.js`, v1.29.0); no stdio references exist in `src/` yet.

## Design principles

- **Agent-agnostic.** The stdio server is a plain MCP server. It assumes only standard MCP over stdio (the `initialize` handshake, `tools/list`, `tools/call`, standard `serverInfo`/capabilities — all provided by the SDK). No coupling to `claude mcp add` or any one client's behavior.
- **Transport-orthogonal axes.** The existing `ENV` (dev|prod) and `MODE` (gateway|flat) axes are unaffected by transport. `MODE=gateway TRANSPORT=stdio` and `MODE=flat TRANSPORT=stdio` both work.
- **Reuse, don't fork.** `createMcpServer` / `createFlatMcpServer`, the registry, BM25 engine, `callDownstream`, projection, and handlers are untouched. Transport is a wiring concern at the entry point.

## Architecture

A third env-var axis, `TRANSPORT`, selects the transport. **Default is `stdio`** so a local user (and any agent) gets the expected local-server behavior without setting anything; the deployed HTTP runtime sets `TRANSPORT=http` explicitly.

```
TRANSPORT=stdio  (default)
  index.ts → loadEnvConfig → registry + engine (built once)
           → authenticateFromEnv(env)            [once, at startup]
           → buildServer(deps, auth)             [once, process lifetime]
           → new StdioServerTransport() → server.connect(transport)
           → run until stdin closes → server.close() → exit

TRANSPORT=http  (current behavior, opt-in via env)
  index.ts → createApp(deps) → app.listen(port)
           per-request: authenticate(headers) → buildServer(deps, auth)
                                      → StreamableHTTPServerTransport
```

### Lifecycle difference (the only semantic shift)

HTTP is **stateless**: a fresh server per request, auth from the header each time. stdio is **one long-lived server for the process**, auth constructed **once** at startup from the environment. Both are valid because the server builders are already pure given `(deps, auth)` — the only difference is construction frequency and the auth source.

### Auth model change (made explicit)

HTTP reads `Authorization: Bearer …` per request (`auth/inbound.ts`). stdio has no per-request headers, so the token comes from an environment variable. The `AuthContext { bearerToken }` type is the shared seam — everything downstream (`callDownstream`, handlers) is unchanged.

The token env-var name is **configurable via `TOKEN_ENV`** (default `GREENNODE_MCP_TOKEN`). Different agents/users store tokens under different names; this decouples the server from any one convention without a hardcoded fallback chain. The token *source* (env) is already agent-agnostic: every spawned process inherits env.

## Components

### `src/config/env.ts` (modify)

- Add `transport: "stdio" | "http"` to `EnvConfig`; `loadEnvConfig` reads `TRANSPORT` (default `"stdio"`, rejects other values with the same throw pattern as `MODE`/`ENV`).
- Add `tokenEnv: string` to `EnvConfig`; `loadEnvConfig` reads `TOKEN_ENV` (default `"GREENNODE_MCP_TOKEN"`). No value restriction beyond non-empty.

### `src/app.ts` (modify)

- Export `buildServer(deps, auth)` — the extracted selection (`deps.config.mode === "flat" ? createFlatMcpServer : createMcpServer`). Both transports call it, so `MODE` keeps working under stdio. Kept here (not a new file) because it is three lines; `createApp`'s inline selection is replaced by a call to `buildServer`.
- `createApp` otherwise unchanged.

### `src/auth/inbound.ts` (modify)

- Add `authenticateFromEnv(env: NodeJS.ProcessEnv, tokenEnv: string): AuthContext` — reads `env[tokenEnv]`, throws `AuthError` (status 401, `"missing upstream token"`) when missing or empty. HTTP's `authenticate(headers)` is untouched.

### `src/index.ts` (modify)

Branch on `config.transport`:

- **`http`** → current path: `createApp()` + `app.listen(port)`. Startup logging to `stderr`.
- **`stdio`** → `authenticateFromEnv(process.env, config.tokenEnv)` once (missing token → `console.error` + `process.exit(1)` *before* connecting) → `buildServer(deps, auth)` once → `new StdioServerTransport()` → `await server.connect(transport)`. `console.error` a one-line startup banner. The process runs until stdin closes; the SDK closes the server and the process exits.

**stdout discipline:** stdio uses stdout for the JSON-RPC protocol. All diagnostic/startup logging is routed to `console.error` (stderr) unconditionally — harmless for HTTP, required for stdio. The existing `console.log("…listening…")` is changed to `console.error`.

### Untouched

`server.ts`, `server-flat.ts`, `meta-tools/handlers.ts`, `http/downstream.ts`, `filter/project.ts`, `registry/loader.ts`, `search/*` — none change. Transport is purely a wiring concern at the entry point.

## Data flow (stdio, one tool call)

1. Process starts: `loadEnvConfig` (TRANSPORT=stdio), registry + BM25 engine built once from `registry.generated.json`.
2. `authenticateFromEnv` reads the token from the env var named by `TOKEN_ENV` (default `GREENNODE_MCP_TOKEN`) → `AuthContext`. If missing/empty, print a clear message to stderr and exit non-zero **before** connecting the transport, so the client sees a clean failure rather than a half-started server.
3. `buildServer(deps, auth)` → one `McpServer` (or low-level `Server` for flat) for the process lifetime.
4. `StdioServerTransport` reads JSON-RPC from stdin; the server dispatches `tools/list` / `tools/call` exactly as HTTP does; `callDownstream` forwards the bearer token to the downstream service; the response returns over stdout.
5. Process exits when stdin closes (client disconnect); the transport handles shutdown, `server.close()` runs.

The only difference from HTTP is steps 2–3 happen **once per process** instead of once per request, and the token source is env, not header.

## Agent-agnostic launch

The launch command is a generic shell command — not specific to any one agent:

```
GREENNODE_MCP_TOKEN=<token> npx tsx src/index.ts          # dev (stdio, default)
ENV=dev MODE=gateway GREENNODE_MCP_TOKEN=<token> npx tsx src/index.ts
TOKEN_ENV=MY_TOKEN MY_TOKEN=<token> npx tsx src/index.ts   # alt token var
```

Config-block shape (generic), specialized per agent as examples:

```jsonc
// Claude Code (.mcp.json)
{ "mcpServers": { "agentbase": { "command": "npx", "args": ["tsx", "src/index.ts"],
  "env": { "GREENNODE_MCP_TOKEN": "<token>" } } } }

// Cursor / Continue / Cline / Zed — same command + env, their own config key
```

**Out of scope:** a compiled distributable build. `package.json`'s `build` is currently `tsc --noEmit` (typecheck only, no `dist/`), so the runnable form today is `tsx`. A real `tsc` build + `bin` field is future work, noted but not done here.

## Error handling

- **Missing token at stdio startup** → `console.error` + `process.exit(1)` before connecting. No half-started server.
- **Invalid `TRANSPORT` / `MODE` / `ENV`** → `loadEnvConfig` throws at boot (existing pattern); non-zero exit, nothing listens.
- **Downstream call failure during a tool call** → handlers already return `isError: true` with the error text; over stdio this is a normal MCP error result on stdout. Transport-agnostic.
- **`callDownstream` throws** (e.g. missing required path param) → caught by the handler, returned as an error result. Existing behavior.
- **stdin closes / transport error** → SDK closes the server, process exits. Standard MCP lifecycle.
- **Uncaught error during `server.connect`** → catch, stderr, exit non-zero.
- **No `console.log` to stdout in stdio mode** — all diagnostics to stderr (stdout is the protocol).

## Testing

- **`env.test.ts`** — `TRANSPORT` defaults to `"stdio"`; accepts `"http"`; rejects invalid values. `TOKEN_ENV` defaults to `"GREENNODE_MCP_TOKEN"`; reflects a custom value.
- **`auth/inbound.test.ts`** — `authenticateFromEnv` returns `AuthContext` when the named env var is set; throws `AuthError` when missing/empty; honors `TOKEN_ENV` (reads from the named var, not the default).
- **`app.test.ts`** — `buildServer(deps, auth)` returns the flat server when `mode === "flat"`, the gateway server otherwise (delegates to the existing constructors; cheap to assert).
- **Smoke tests (spawn the process):**
  - `TRANSPORT=stdio` + missing token → exits non-zero with a stderr message (mirrors the flatten plan's boot-time smoke checks).
  - `TRANSPORT=stdio` + valid token → pipe `initialize` + `tools/list` JSON-RPC over stdin → assert 3 tools (gateway) / 116 (flat). Run for both `MODE=gateway` and `MODE=flat`.
- **Existing tests unchanged** — `server.test.ts`, `server-flat.test.ts`, `app.test.ts` (current cases), `handlers.test.ts` all pass as-is.

## Migration note

**Deployed HTTP runtimes must set `TRANSPORT=http`.** Because the default flips to `stdio`, an HTTP runtime that does not set `TRANSPORT=http` will start in stdio mode and not listen on a port — a silent break. The runtime's env config must add `TRANSPORT=http` (one line). This is the only externally-visible change for the deployed path.

## Out of scope

- **No compiled distributable build.** `tsx` remains the runner; `tsc` emit + `bin` is future work.
- **No token refresh / multi-credential handling.** One token, read once at startup. A long-lived stdio session with an expiring token will fail downstream calls when the token expires — same as the HTTP path; not solved here.
- **No new auth mechanisms.** Only env-sourced bearer, matching the existing downstream auth. No OAuth, no per-tool credentials.
- **No change to the deployed HTTP endpoint behavior** beyond the `TRANSPORT=http` env requirement.
