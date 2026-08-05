import type { EnvConfig } from "../config/env.js";
import type { RegistryStore } from "../registry/loader.js";
import type { SearchEngine } from "../search/engine.js";
import { projectAndCap } from "../filter/project.js";
import { callDownstream, type FetchLike } from "../http/downstream.js";
import type { AuthContext } from "../auth/inbound.js";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface HandlerDeps {
  registry: RegistryStore;
  engine: SearchEngine;
  config: EnvConfig;
  fetchImpl?: FetchLike;
}

function text(value: unknown, isError = false): ToolResult {
  const t = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text", text: t }], isError: isError || undefined };
}

export function listServers(deps: HandlerDeps): ToolResult {
  return text(deps.registry.servers());
}

export function searchTools(
  deps: HandlerDeps,
  args: { query: string; server?: string; limit?: number },
): ToolResult {
  const hits = deps.engine.search(args.query, {
    server: args.server,
    limit: args.limit ?? deps.config.searchLimitDefault,
  });
  return text(hits);
}

export async function executeTool(
  deps: HandlerDeps,
  auth: AuthContext,
  args: { id: string; args?: Record<string, any>; fields?: string },
): Promise<ToolResult> {
  const op = deps.registry.getById(args.id);
  if (!op) return text(`unknown operation: ${args.id}`, true);

  const baseUrl = deps.config.baseUrls[op.service];
  if (!baseUrl) return text(`no base URL for service: ${op.service}`, true);

  try {
    const res = await callDownstream(
      {
        op,
        args: args.args ?? {},
        baseUrl,
        bearerToken: auth.bearerToken,
      },
      deps.fetchImpl,
    );
    const projected = projectAndCap(
      res.body,
      args.fields,
      deps.config.maxResponseBytes,
    );
    const isError = res.status >= 400;
    return text(
      isError ? `HTTP ${res.status}: ${projected.text}` : projected.text,
      isError,
    );
  } catch (e) {
    return text(`downstream call failed: ${(e as Error).message}`, true);
  }
}
