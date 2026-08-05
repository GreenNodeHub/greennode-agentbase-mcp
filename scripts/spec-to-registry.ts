import SwaggerParser from "@apidevtools/swagger-parser";
// swagger2openapi has no bundled types; import as untyped.
import { convertObj } from "swagger2openapi";
import type {
  JsonSchema,
  ParamSpec,
  Registry,
  RegistryOperation,
} from "../src/registry/types.js";

const HTTP_METHODS = ["get", "post", "put", "delete", "patch"] as const;

/** Convert Swagger 2.0 -> OpenAPI 3 if needed, then dereference all $refs. */
export async function normalizeSpec(rawSpec: unknown): Promise<any> {
  const doc = rawSpec as any;
  let oas = doc;
  if (doc.swagger === "2.0") {
    const converted = await convertObj(doc, { warnOnly: true });
    oas = converted.openapi;
  }
  // dereference resolves every $ref into inline schemas
  return (await SwaggerParser.dereference(oas)) as any;
}

function paramSpec(p: any): ParamSpec {
  return {
    name: p.name,
    location: p.in as ParamSpec["location"],
    required: Boolean(p.required),
    // OAS3 params carry .schema; be defensive for odd shapes.
    schema: (p.schema ?? { type: "string" }) as JsonSchema,
  };
}

function bodySchema(op: any): JsonSchema | undefined {
  const content = op.requestBody?.content;
  if (!content) return undefined;
  const json =
    content["application/json"] ??
    content[Object.keys(content)[0]];
  return json?.schema as JsonSchema | undefined;
}

function buildInputSchema(
  params: ParamSpec[],
  body: JsonSchema | undefined,
  bodyRequired: boolean,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const p of params) {
    properties[p.name] = { ...p.schema, description: p.schema.description };
    if (p.required) required.push(p.name);
  }
  if (body) {
    properties.body = body;
    if (bodyRequired) required.push("body");
  }
  const schema: JsonSchema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

export function extractOperations(
  service: string,
  oas: any,
): RegistryOperation[] {
  const ops: RegistryOperation[] = [];
  const paths = oas.paths ?? {};
  for (const [path, item] of Object.entries<any>(paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;

      const rawParams: any[] = [
        ...(item.parameters ?? []),
        ...(op.parameters ?? []),
      ];
      const params = rawParams
        .filter((p) => ["path", "query", "header"].includes(p.in))
        .map(paramSpec);

      const body = bodySchema(op);
      const bodyRequired = Boolean(op.requestBody?.required);

      const operationId: string =
        op.operationId ?? `${method}${path.replace(/[^a-zA-Z0-9]/g, "_")}`;

      ops.push({
        id: `${service}.${operationId}`,
        service,
        operationId,
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? op.description ?? operationId,
        tags: op.tags ?? [],
        parameters: params,
        hasBody: Boolean(body),
        bodyRequired,
        inputSchema: buildInputSchema(params, body, bodyRequired),
      });
    }
  }
  return ops;
}

export async function buildRegistry(
  specs: { service: string; raw: unknown }[],
): Promise<Registry> {
  const operations: RegistryOperation[] = [];
  for (const { service, raw } of specs) {
    const oas = await normalizeSpec(raw);
    operations.push(...extractOperations(service, oas));
  }
  return { operations };
}
