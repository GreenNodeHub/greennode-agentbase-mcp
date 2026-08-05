# greennode-agentbase-mcp

An MCP server that exposes the GreenNode AgentBase REST APIs as **3 searchable meta-tools** — a search→execute gateway that cuts the MCP tool-definition tax ~95%+ versus flattening every operation into its own tool. Runs locally over **stdio** (default) or remotely over **streamable HTTP**, with any MCP-speaking client.

## Table of contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Transports: stdio vs. streamable HTTP](#transports-stdio-vs-streamable-http)
- [Configuration](#configuration)
- [Development & operations](#development--operations)
- [Further reading](#further-reading)
- [License](#license)

## Quick start

Connect a local MCP client (Claude Code, Cursor, Windsurf, …) to the gateway over stdio in under a minute.

**Prerequisites**

- Node.js ≥ 20 (see `package.json` `engines`)
- A GreenNode AgentBase bearer token — one token is valid across all six services

**1. Install**

```bash
git clone https://github.com/GreenNodeHub/greennode-agentbase-mcp.git
cd greennode-agentbase-mcp
npm ci
```

**2. Run** (stdio is the default transport — no need to set `TRANSPORT`)

```bash
GREENNODE_MCP_TOKEN=<your-token> npm start
```

**3. Wire up your client.** Claude Code — `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "agentbase": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "env": { "GREENNODE_MCP_TOKEN": "<your-token>" }
    }
  }
}
```

For Cursor, Windsurf, Cline, Roo Code, Claude Desktop, and other clients, see [`docs/mcp-client-quickstart.html`](docs/mcp-client-quickstart.html) — same command + env, each client's own config key.

> **Optional — auto-rotating token (external).** If you have the `agentbase` skill installed (it ships `.claude/skills/agentbase/scripts/get_token.sh`, which is **not** part of this repo) plus `GREENNODE_CLIENT_ID` / `GREENNODE_CLIENT_SECRET` (or a `.greennode.json`), point your client at [`scripts/mcp-launch.sh`](scripts/mcp-launch.sh) instead. It mints a fresh ~30-minute IAM JWT on every (re)start, so reconnecting rotates the token automatically — no manual re-export, no stale-token 401s.

**First call flow:** `list_servers` → `search_tools` → `execute` (see [How it works](#how-it-works)).

## How it works

Instead of exposing 100+ operations as individual MCP tools (a large manifest the model pays for every turn), the server exposes **3 meta-tools**. The full operation set lives in a generated registry the model searches on demand.

```
┌───────────────────────────────────────────────────────────┐
│  Generated layer  (from specs, committed, never hand-edited) │
│    registry.generated.json                                  │
│      every operation: { id, service, method, path,          │
│                         summary, tags, inputSchema }         │
└───────────────────────────────────────────────────────────────┘
                          ▲ consumed by
┌───────────────────────────────────────────────────────────┐
│  Meta layer  (hand-written TypeScript)                      │
│    • 3 meta-tools: list_servers, search_tools, execute      │
│    • BM25 search engine                                     │
│    • JMESPath field projection + response byte cap          │
│    • inbound auth + downstream token pass-through           │
│    • env resolver (base URLs, transport, limits)            │
└───────────────────────────────────────────────────────────────┘
```

### Meta-tools

| Tool | Args | Returns |
|---|---|---|
| `list_servers` | — | the services, each with its operation count + tags |
| `search_tools` | `query`, `server?`, `limit?` | BM25-ranked operations, each with its **full `inputSchema` inline** |
| `execute` | `id`, `args?`, `fields?` | the real HTTP response, projected by `fields` and byte-capped |

Discovery is two steps: `search_tools` returns enough to call `execute` directly (the input schema is inline), so there's no separate describe step.

```jsonc
// 1) orient on the six services
list_servers()
// → [{ "name": "policy", "description": "policy service (… operations)", "operationCount": …, "tags": […] }, …]

// 2) search by intent — the id and full inputSchema come back together
search_tools({ query: "list policy groups" })
// → [{ "id": "policy.get_api_v1_policy_groups", "service": "policy",
//      "summary": "List policy groups", "inputSchema": { "type": "object",
//      "properties": { "page": {…}, "page_size": {…}, "name": {…} } } }, …]

// 3) execute; `fields` is an optional JMESPath projection to shrink the response
execute({ id: "policy.get_api_v1_policy_groups", args: { page: 1, page_size: 10 } })
// → the live response (omit `fields` to see the whole body; pass e.g. fields:"items[].name" to project it)
```

**Operation ids** look like `service.<method>_<slugified-path>` (e.g. `policy.get_api_v1_policy_groups`). Always take an id from `search_tools` — never type one by hand.

**Why meta-tools:** 3 tool definitions (~1–2K resident tokens) instead of one tool per operation. See [`benchmarks/report-2026-07-06.md`](benchmarks/report-2026-07-06.md) for the token math — a 36.8× smaller manifest and 7–41% fewer input tokens end-to-end versus the flat (one-tool-per-op) variant.

## Transports: stdio vs. streamable HTTP

| | stdio | streamable HTTP |
|---|---|---|
| Use case | local, any MCP client | deployed runtime / remote clients |
| Default | yes (`TRANSPORT=stdio`) | opt-in (`TRANSPORT=http`) |
| Lifecycle | one server for the process lifetime | fresh server + transport per request (stateless) |
| Token source | env var (`GREENNODE_MCP_TOKEN`, or `TOKEN_ENV`) | `Authorization: Bearer` header, per request |
| Endpoint | stdin/stdout (JSON-RPC) | `POST /mcp` |
| Health | — | `GET /healthz`, `GET /health` |

### stdio (default)

The server reads JSON-RPC from stdin and writes responses to stdout. **stdout is the protocol** — all diagnostics and the one-line startup banner go to stderr, so they never corrupt the stream.

```bash
GREENNODE_MCP_TOKEN=<your-token> npm start   # TRANSPORT=stdio is the default
```

The token is read **once at startup** from the env var named by `TOKEN_ENV` (default `GREENNODE_MCP_TOKEN`). The server runs for the process lifetime and exits when the client closes stdin. See [Quick start](#quick-start) for the client-wiring snippet.

### Streamable HTTP

For a deployed runtime or remote clients. Each `POST /mcp` builds a fresh server + `StreamableHTTPServerTransport` for that request (stateless) and authenticates from the `Authorization` header. The token is **not** read from the environment in this mode.

```bash
TRANSPORT=http npm start   # listens on :8080 (PORT); pass the token per request, not via env
```

Smoke-test it:

```bash
curl http://localhost:8080/healthz          # → {"ok":true}

# a raw initialize request to /mcp (clients normally build this JSON-RPC envelope for you)
curl -X POST http://localhost:8080/mcp \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

## License

See [`LICENSE`](LICENSE).
