#!/usr/bin/env bash
# Phase 3 — multi-turn end-to-end token comparison: gateway vs flat.
#
# Runs a suite of tasks headlessly via `claude -p --output-format stream-json`,
# once against the gateway variant (3 meta-tools) and once against the flat
# variant (116 tools), using --strict-mcp-config so only ONE server is visible
# per run. Parses the stream for per-turn usage and emits a markdown comparison
# table. This is the "real" MCP-tax measurement — gross input tokens (context
# pollution) plus cache read/write (dollar cost) on identical work.
#
# Usage:
#   export GREENNODE_MCP_TOKEN="<fresh-token>"   # 30-min JWT — mint before running
#   ./benchmarks/phase3-suite.sh                 # run all tasks × both variants
#   ./benchmarks/phase3-suite.sh --dry-run       # print the claude commands only
#   ./benchmarks/phase3-suite.sh --only single-op        # run one task
#   ./benchmarks/phase3-suite.sh --variant gateway       # run one variant
#   MODEL=sonnet MAX_TURN_SEC=240 ./benchmarks/phase3-suite.sh
#
# Env:
#   GREENNODE_MCP_TOKEN  (required) bearer token forwarded downstream
#   MODEL                (default sonnet) pinned for both variants — fairness
#   MAX_TURN_SEC         (default 240) per-run wall-clock cap
#   OUTDIR               (default /tmp/bench-phase3) where artifacts land
set -euo pipefail

: "${GREENNODE_MCP_TOKEN:?must be exported — mint a fresh token and: export GREENNODE_MCP_TOKEN=...}"
MODEL="${MODEL:-sonnet}"
MAX_TURN_SEC="${MAX_TURN_SEC:-240}"
OUTDIR="${OUTDIR:-/tmp/bench-phase3}"
DRY_RUN=0; ONLY_TASK=""; ONLY_VARIANT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift;;
    --only) ONLY_TASK="$2"; shift 2;;
    --variant) ONLY_VARIANT="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

GATEWAY_URL="https://endpoint-556ba588-2efe-4b68-8799-6645bae86e4d.agentbase-runtime.aiplatform.vngcloud.vn/mcp"
FLAT_URL="https://endpoint-3491932f-0451-42a7-b6e8-5ba82a03c678.agentbase-runtime.aiplatform.vngcloud.vn/mcp"

mkdir -p "$OUTDIR"

# --- build two single-server mcp-config files (token inlined; ${...} is not
#     interpolated in a custom --mcp-config file) ---
make_cfg() { # $1=url $2=outpath
  cat > "$2" <<JSON
{ "mcpServers": { "agentbase": { "type": "http", "url": "$1", "headers": { "Authorization": "Bearer ${GREENNODE_MCP_TOKEN}" } } } }
JSON
}
make_cfg "$GATEWAY_URL" "$OUTDIR/cfg-gateway.json"
make_cfg "$FLAT_URL"    "$OUTDIR/cfg-flat.json"

# --- task suite (EDIT ME — design tasks that exercise your access patterns) ---
# Format: "key|prompt". Keep prompts identical across variants; the harness
# swaps the MCP config, nothing else. Tasks below are starter shapes:
#   single-op        — one op, one service (flat's manifest tax shows unamortized)
#   multi-op-same    — 2 ops, one service (tests gateway search reuse)
#   multi-op-cross   — 3 ops across services (gateway's on-demand schemas shine)
TASKS=(
  "single-op|List my agent runtimes and tell me how many there are."
  "multi-op-same|List my gateways. Then for the first gateway, tell me its flavor, replicas, and network mode."
  "multi-op-cross|List my policy groups. Then list my agent runtimes. Tell me which runtime names (if any) mention a policy group name."
  "multi-op-long|List all my agent runtimes. For the FIRST runtime in the list, tell me: its name and status, how many endpoints it has, and how many versions it has. Use the runtime's id from the list to fetch details, endpoints, and versions."
)
VARIANTS=(gateway flat)

# --- run one task against one variant, parse stream-json, emit a JSON summary ---
run_one() { # $1=task-key $2=prompt $3=variant
  local key="$1" prompt="$2" variant="$3"
  local cfg="$OUTDIR/cfg-${variant}.json"
  local stream="$OUTDIR/${key}__${variant}.stream.jsonl"
  local summary="$OUTDIR/${key}__${variant}.summary.json"
  local t0 t1 rc
  echo "  ▶ $key / $variant …" >&2
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "     (dry-run) claude -p <prompt> --model $MODEL --output-format stream-json --strict-mcp-config --mcp-config $cfg --dangerously-skip-permissions" >&2
    return 0
  fi
  t0=$(date +%s)
  # portable timeout: macOS has no `timeout` by default; perl alarm works everywhere.
  perl -e 'alarm shift @ARGV; exec @ARGV' "$MAX_TURN_SEC" claude -p "$prompt" \
    --model "$MODEL" \
    --output-format stream-json \
    --strict-mcp-config --mcp-config "$cfg" \
    --disallowed-tools Bash Skill \
    --dangerously-skip-permissions \
    > "$stream" 2>"$OUTDIR/${key}__${variant}.stderr" || {
      echo "     ⚠ run failed or timed out (see $OUTDIR/${key}__${variant}.stderr)" >&2
    }
  t1=$(date +%s)
  python3 - "$stream" "$variant" "$key" "$((t1-t0))" <<'PY'
import json, sys
stream, variant, key, wall = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
turns = tool_calls = 0
tool_ids = set()
last_result = None
with open(stream) as f:
    for ln in f:
        ln = ln.strip()
        if not ln: continue
        try: o = json.loads(ln)
        except json.JSONDecodeError: continue
        t = o.get("type")
        if t == "assistant":
            turns += 1
            for blk in (o.get("message") or {}).get("content") or []:
                # tool_use blocks: count distinct tool calls (dedupe by id, since
                # stream-json can re-emit partials)
                if isinstance(blk, dict) and blk.get("type") == "tool_use":
                    tid = blk.get("id")
                    if not tid or tid not in tool_ids:
                        tool_ids.add(tid); tool_calls += 1
        elif t == "result":
            last_result = o
# Usage: the z-ai/glm backend (and some others) reports 0 on every assistant
# turn and aggregates only in the final `result` message. Prefer result.usage
# when it carries non-zero input; otherwise fall back to summing per-turn usage.
ru = (last_result or {}).get("usage") or {}
cost = (last_result or {}).get("cost_usd") or (last_result or {}).get("total_cost_usd")
rin = ru.get("input_tokens", 0)
# result.num_turns is the model's own turn count; fall back to counted turns
result_turns = (last_result or {}).get("num_turns") or turns
out = {
  "task": key, "variant": variant,
  "turns": result_turns, "tool_calls": tool_calls, "wall_s": wall,
  "input_tokens": rin,
  "output_tokens": ru.get("output_tokens", 0),
  "cache_read": ru.get("cache_read_input_tokens", 0),
  "cache_creation": ru.get("cache_creation_input_tokens", 0),
  "final_input_tokens": rin,
  "cost_usd": cost,
}
print(json.dumps(out))
PY
}

echo "Phase 3 suite — model=$MODEL  token-ttl=30m  out=$OUTDIR"
[[ $DRY_RUN -eq 1 ]] && echo "(dry run — no claude invocations)"

summaries=()
for task in "${TASKS[@]}"; do
  IFS='|' read -r key prompt <<< "$task"
  [[ -n "$ONLY_TASK" && "$key" != "$ONLY_TASK" ]] && continue
  for v in "${VARIANTS[@]}"; do
    [[ -n "$ONLY_VARIANT" && "$v" != "$ONLY_VARIANT" ]] && continue
    s=$(run_one "$key" "$prompt" "$v")
    [[ $DRY_RUN -eq 0 ]] && summaries+=("$s")
  done
done

if [[ $DRY_RUN -eq 1 || ${#summaries[@]} -eq 0 ]]; then
  echo "done (no summaries to tabulate)."
  exit 0
fi

# --- tabulate ---
printf '%s\n' "${summaries[@]}" > "$OUTDIR/summaries.jsonl"
python3 - <<'PY'
import json, os
rows = [json.loads(l) for l in open(os.environ.get("OUTDIR","/tmp/bench-phase3") + "/summaries.jsonl")]
# group by task
from collections import defaultdict
by_task = defaultdict(dict)
for r in rows: by_task[r["task"]][r["variant"]] = r
def cell(v, k, fmt="{}"): return fmt.format(v[k]) if v else "—"
print("\n## Phase 3 — end-to-end token comparison\n")
print("| task | variant | turns | tool_calls | input | output | cache_read | cache_write | final_input | wall_s |")
print("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|")
for task in sorted(by_task):
    for v in ("gateway","flat"):
        r = by_task[task].get(v)
        if not r: continue
        print(f"| {task} | {v} | {r['turns']} | {r['tool_calls']} | {r['input_tokens']:,} | {r['output_tokens']:,} | {r['cache_read']:,} | {r['cache_creation']:,} | {r['final_input_tokens']:,} | {r['wall_s']} |")
# delta table
print("\n### Δ (flat − gateway) per task\n")
print("| task | Δinput | Δfinal_input | Δcache_read | Δtool_calls | Δwall_s |")
print("|---|---:|---:|---:|---:|---:|")
for task in sorted(by_task):
    g, f = by_task[task].get("gateway"), by_task[task].get("flat")
    if not g or not f: continue
    di = f["input_tokens"] - g["input_tokens"]
    dfi = f["final_input_tokens"] - g["final_input_tokens"]
    dcr = f["cache_read"] - g["cache_read"]
    dtc = f["tool_calls"] - g["tool_calls"]
    dw = f["wall_s"] - g["wall_s"]
    print(f"| {task} | {di:+,} | {dfi:+,} | {dcr:+,} | {dtc:+,} | {dw:+} |")
print("\n_raw: $OUTDIR/summaries.jsonl  (per-run stream-jsonl alongside)")
PY
