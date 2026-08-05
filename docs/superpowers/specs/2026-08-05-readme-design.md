# README — Design

**Date:** 2026-08-05
**Status:** Approved outline, pre-implementation
**Target file:** `README.md` (repo root — replaces the current 2-line stub)

## Goal

Write a user-facing README for `greennode-agentbase-mcp` that lets a reader
understand what the server is, get a local stdio client connected in under a
minute, choose between stdio and streamable HTTP, and operate/extend it — while
honoring README best practice (quickstart-first, one clear happy path, link out
for breadth, concise dev section, accurate facts).

## Audience

Developers and agents who want to **run and connect** the MCP server to an
MCP-speaking client (Claude Code/Desktop, Cursor, Windsurf, Cline, Roo Code,
Continue, Zed). They already have AgentBase access and a bearer token; they do
not need an AgentBase primer. Architecture is included for context, not as a
contributor manual.

## Chosen approach

**Approach 1 — Quickstart-first, balanced.** Lead with a ~30-second happy path;
follow with architecture, a stdio-vs-streamable comparison + how-to for each, a
config reference, a concise Development/Operations section, and links to
existing deeper docs. One happy path; per-client breadth and benchmarks live
behind links.

Rejected: Approach 2 (no dev section — below best practice for a code repo) and
Approach 3 (comprehensive inline per-client + troubleshooting — duplicates the
existing `docs/mcp-client-quickstart.html` and creates staleness risk).

## Confirmed decisions

- **Token path (quickstart lead):** `GREENNODE_MCP_TOKEN=<token>` set directly
  by the user. `scripts/mcp-launch.sh` is mentioned as **optional**, clearly
  marked as depending on the **external** `agentbase` skill
  (`.claude/skills/agentbase/scripts/get_token.sh`, not in this repo) +
  `GREENNODE_CLIENT_ID/SECRET`.
- **Lead transport:** stdio (it is the default and the local use case). HTTP is
  presented as the deployed-runtime path, with equal how-to depth.
- **Dockerfile fix:** **out of scope.** The README documents the
  `TRANSPORT=http` requirement for the container; the shipped `Dockerfile` is
  not modified in this work.

## Section-by-section outline

### 1. Title + hook
- `# greennode-agentbase-mcp`
- One-line: "An MCP server that exposes the GreenNode AgentBase REST APIs as 3
  searchable meta-tools."
- 2-sentence what/why: the search→execute gateway cuts the MCP tool-definition
  tax ~95%+ vs. flattening every operation into a tool; runs locally over stdio
  or remotely over streamable HTTP with any MCP client.

### 2. Table of contents
- Standard nested list, links to each section below.

### 3. Quick start (stdio, local) — the happy path
- Prereqs: Node ≥20 (from `package.json` `engines`), an AgentBase bearer token.
- Clone + `npm ci`.
- `GREENNODE_MCP_TOKEN=<token> npm start` (`TRANSPORT=stdio` is the default; no
  need to set it).
- One inline client-wiring example: **Claude Code** `.mcp.json`:
  ```jsonc
  { "mcpServers": { "agentbase": { "command": "npx", "args": ["tsx", "src/index.ts"],
    "env": { "GREENNODE_MCP_TOKEN": "<token>" } } } }
  ```
  Link to `docs/mcp-client-quickstart.html` for Cursor/Windsurf/Cline/Roo
  Code/Continue/Zed/Claude Desktop.
- Optional aside (clearly marked optional + external): `scripts/mcp-launch.sh`
  for users with the `agentbase` skill + `GREENNODE_CLIENT_ID/SECRET` —
  auto-rotates a ~30-min IAM JWT on every (re)start.
- One-line first-call flow: `list_servers` → `search_tools` → `execute`.

### 4. How it works (architecture)
- 2-layer ASCII diagram (adapted from the gateway design doc):
  - **Generated layer:** `registry.generated.json` — all operations, generated
    from specs, never hand-edited.
  - **Meta layer (hand-written TS):** 3 meta-tools + BM25 search + JMESPath
    `fields` projection + byte cap + auth pass-through + env resolver.
- Meta-tools table:

  | Tool | Args | Returns |
  |---|---|---|
  | `list_servers` | — | services with op counts + tags |
  | `search_tools` | `query`, `server?`, `limit?` | ranked ops, **full inputSchema inline** |
  | `execute` | `id`, `args?`, `fields?` | the real HTTP response, projected + capped |

- 2-step discovery flow: `search_tools` (schema inline) → `execute` (no separate
  describe step).
- Why meta-tools: ~1–2K resident tokens (3 tool defs) vs. 100+ flat; link to
  `benchmarks/report-2026-07-06.md` for the numbers. **Do not hardcode an op
  count** — `list_servers` returns the live number; prose says "100+" loosely.
- Worked example with a **verified real id**:
  - `search_tools({ query: "list policy groups" })` → hit
    `policy.get_api_v1_policy_groups`
  - `execute({ id: "policy.get_api_v1_policy_groups", fields: "items[].name" })`
    (the `fields` value is **illustrative** — in the README, verify it against
    the actual `policy-groups` response shape, or label it as a JMESPath
    example rather than a guaranteed field path).

### 5. Transports: stdio vs. streamable HTTP
- Comparison table — rows: lifecycle, token source, use case, how to run,
  endpoint, statefulness/sessions.

- **stdio** subsection:
  - When: local, any MCP client.
  - Env: `TRANSPORT=stdio` (default); token from `GREENNODE_MCP_TOKEN` or
    whatever name `TOKEN_ENV` selects.
  - Lifecycle: one server for the process lifetime; exits when stdin closes.
  - **stdout is the JSON-RPC protocol** — all diagnostics go to stderr.
  - Launch + the same `.mcp.json` snippet as the quickstart.

- **Streamable HTTP** subsection:
  - When: deployed runtime / remote clients.
  - Env: `TRANSPORT=http`, `PORT` (default 8080).
  - Stateless: fresh server + `StreamableHTTPServerTransport` per request, token
    from `Authorization: Bearer`.
  - Endpoint `POST /mcp`; healthchecks `GET /healthz` and `GET /health`.
  - Run: `TRANSPORT=http npm start` (`PORT` defaults to 8080). The token is
    **not** read from the environment in HTTP mode — clients supply it per
    request via the `Authorization: Bearer` header (see the `curl` example).
  - `curl` example: `curl -H "Authorization: Bearer <token>" -H
    "Content-Type: application/json" -d '{"jsonrpc":"2.0",...}' http://localhost:8080/mcp`
    (and `curl http://localhost:8080/healthz`).

### 6. Configuration (env vars)
Table with columns `Var`, `Default`, `Notes`:

| Var | Default | Notes |
|---|---|---|
| `TRANSPORT` | `stdio` | `stdio` or `http`; anything else throws at boot |
| `GREENNODE_MCP_TOKEN` | — | Upstream bearer token (stdio). Forwarded to all 6 services |
| `TOKEN_ENV` | `GREENNODE_MCP_TOKEN` | Name of the env var that holds the token (stdio) |
| `PORT` | `8080` | HTTP transport listen port |
| `MAX_RESPONSE_BYTES` | `25000` | Hard cap on `execute` responses; truncate + notice on overflow |
| `SEARCH_LIMIT_DEFAULT` | `5` | Default `limit` for `search_tools` |

### 7. Development & operations (concise)
- Scripts (from `package.json`): `build` (tsc typecheck, no emit), `test` /
  `test:watch` (vitest), `dev` (`tsx watch`), `start` (`tsx`), `fetch-specs`,
  `generate-registry`.
- Regenerating the registry when specs change:
  `npm run fetch-specs && npm run generate-registry`, then commit
  `specs/` + `registry.generated.json` (both generated, never hand-edited).
- Docker:
  `docker build -t greennode-agentbase-mcp . && docker run -e TRANSPORT=http -p 8080:8080 greennode-agentbase-mcp`
  (the bearer token is supplied per request via the `Authorization` header, not
  env — same as HTTP mode above).
- ⚠️ **Gotcha call-out:** `TRANSPORT` defaults to `stdio`, so a deployed HTTP
  runtime — and the shipped `Dockerfile` (which sets `ENV PORT=8080` but not
  `TRANSPORT`) — **must set `TRANSPORT=http`** or nothing listens on the port.
  (Documented only; Dockerfile not patched in this work.)

### 8. Further reading
- `docs/mcp-client-quickstart.html` — per-client wiring (Claude Desktop/Code,
  Cursor, Windsurf, Claude.ai, Cline, Roo Code, agent frameworks).
- `benchmarks/report-2026-07-06.md` — gateway vs. flat token math (36.8×
  manifest-tax reduction; gateway wins 7–41% fewer input tokens end-to-end).
- `specs/README.md` — spec sources + regenerate notes.
- `docs/superpowers/specs/` — design docs (gateway, stdio local server,
  flatten baseline).

### 9. License
- Note the `LICENSE` file is present.

## Accuracy constraints (must honor)

1. **Operation ids** are `service.<method>_<slugified-path>`
   (e.g. `policy.get_api_v1_policy_groups`, verified in
   `registry.generated.json`) — **not** `service.operationId`. Always say "take
   ids from `search_tools`."
2. **Op count is not hardcoded.** Old design docs say 116; the live registry is
   109 and will change. Use "100+" in prose and let `list_servers` give the real
   number.
3. **`fields` is JMESPath**, not JSONPath/jq (the `jmespath` dependency +
   `filter/project.ts` confirm it).
4. **`TRANSPORT` default is `stdio`.** HTTP is opt-in. A runtime that forgets
   `TRANSPORT=http` silently runs stdio and listens on nothing.
5. **Inbound auth differs by transport:** HTTP reads `Authorization: Bearer` per
   request; stdio reads the token from the env var named by `TOKEN_ENV` once at
   startup. Downstream auth is identical (forward one bearer to all services).
6. **stdio stdout is the protocol.** All diagnostics/startup banners go to
   stderr (`console.error`).
7. **No compiled build.** `build` = `tsc --noEmit`; the runnable form is `tsx`.
   Don't imply a `dist/` or a `bin`.
8. **`mcp-launch.sh` is external-dependent.** It shells out to
   `.claude/skills/agentbase/scripts/get_token.sh`, which is not in this repo.
   Never present it as the primary path; always mark it optional + external.

## Out of scope

- Per-client inline config for every MCP client (link to the HTML quickstart).
- A troubleshooting section.
- Patching the `Dockerfile` to set `TRANSPORT=http`.
- A compiled distributable build / `bin` field.
- Re-explaining AgentBase itself (audience already has access).
