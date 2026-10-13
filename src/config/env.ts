export const SERVICES = [
  "policy",
  "cr",
  "gateway",
  "identity",
  "memory",
  "runtime",
  "tools",
] as const;

export type ServiceName = (typeof SERVICES)[number];

// The server only supports prod. Downstream base URLs are fixed.
//
// tools (built-in browsers + code interpreters) is dev-only today: its prod
// host is a placeholder, mirroring the greennode-cli wiring. The spec's paths
// are version-less (its basePath carries the /v1), so this base URL carries
// the version prefix — joined URLs resolve to <host>/v1/browsers, matching
// the CLI's prod endpoint scheme.
const BASE_URLS: Record<ServiceName, string> = {
  policy: "https://agentbase.api.vngcloud.vn/policy",
  cr: "https://agentbase.api.vngcloud.vn/cr",
  gateway: "https://agentbase.api.vngcloud.vn/gateway",
  identity: "https://agentbase.api.vngcloud.vn/identity",
  memory: "https://agentbase.api.vngcloud.vn/memory",
  runtime: "https://agentbase.api.vngcloud.vn/runtime",
  tools: "https://agent-core-built-in-tools.api.vngcloud.vn/v1",
};

export type Transport = "stdio" | "http";

export interface EnvConfig {
  baseUrls: Record<string, string>;
  maxResponseBytes: number;
  port: number;
  searchLimitDefault: number;
  transport: Transport;
  tokenEnv: string;
}

export function loadEnvConfig(env: NodeJS.ProcessEnv): EnvConfig {
  const transportRaw = env.TRANSPORT ?? "stdio";
  if (transportRaw !== "stdio" && transportRaw !== "http") {
    throw new Error(
      `Invalid TRANSPORT "${transportRaw}": expected "stdio" or "http"`,
    );
  }
  const transport = transportRaw as Transport;

  const tokenEnv = env.TOKEN_ENV ?? "GREENNODE_MCP_TOKEN";

  return {
    baseUrls: { ...BASE_URLS },
    maxResponseBytes: Number(env.MAX_RESPONSE_BYTES ?? 25_000),
    port: Number(env.PORT ?? 8080),
    searchLimitDefault: Number(env.SEARCH_LIMIT_DEFAULT ?? 5),
    transport,
    tokenEnv,
  };
}
