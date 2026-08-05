#!/usr/bin/env bash
# scripts/mcp-launch.sh — mint a fresh IAM JWT, then run the stdio MCP server.
#
# Point any stdio MCP client (Claude Desktop, Claude Code, Cursor, Windsurf,
# Cline, Roo Code) at this instead of `npx tsx src/index.ts`. Every (re)start
# re-mints the token, so relaunching / reconnecting the client rotates the
# ~30-min IAM JWT automatically — no manual re-export, no stale-token 401s.
#
# Requires GREENNODE_CLIENT_ID + GREENNODE_CLIENT_SECRET in the env, or a
# .greennode.json in the repo root. get_token.sh caches the token in
# .agentbase/token_cache with a 60s safety margin on the JWT exp.
#
# In a client config:
#   "command": "bash",
#   "args": ["/ABSOLUTE/PATH/TO/greennode-agentbase-mcp/scripts/mcp-launch.sh"]

set -euo pipefail

# Resolve the repo root from this script's location, so the client's cwd
# (which may differ — Claude Desktop launches from elsewhere) doesn't matter.
cd "$(dirname "$0")/.."

export GREENNODE_MCP_TOKEN="$(bash .claude/skills/agentbase/scripts/get_token.sh)"
exec npx tsx src/index.ts
