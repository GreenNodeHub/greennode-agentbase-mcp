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

## License

See [`LICENSE`](LICENSE).
