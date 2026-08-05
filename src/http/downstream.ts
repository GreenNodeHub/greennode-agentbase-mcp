import type { RegistryOperation } from "../registry/types.js";

export type FetchLike = (
  url: string,
  init?: any,
) => Promise<{
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}>;

export interface DownstreamRequest {
  op: RegistryOperation;
  args: Record<string, any>;
  baseUrl: string;
  bearerToken: string;
}

export interface DownstreamResponse {
  status: number;
  body: unknown;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export async function callDownstream(
  req: DownstreamRequest,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<DownstreamResponse> {
  const { op, args, baseUrl, bearerToken } = req;

  let path = op.path;
  const query = new URLSearchParams();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearerToken}`,
    Accept: "application/json",
  };

  for (const p of op.parameters) {
    const val = args[p.name];
    if (val === undefined || val === null) {
      if (p.location === "path" && p.required) {
        throw new Error(`missing required parameter: ${p.name}`);
      }
      continue;
    }
    if (p.location === "path") {
      path = path.replace(`{${p.name}}`, encodeURIComponent(String(val)));
    } else if (p.location === "query") {
      query.append(p.name, String(val));
    } else if (p.location === "header") {
      headers[p.name] = String(val);
    }
  }

  const qs = query.toString();
  const url = joinUrl(baseUrl, path) + (qs ? `?${qs}` : "");

  const init: any = { method: op.method, headers };
  if (op.hasBody && args.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(args.body);
  }

  const res = await fetchImpl(url, init);
  const raw = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  let body: unknown = raw;
  if (contentType.includes("application/json") && raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  return { status: res.status, body };
}
