# AgentBase MCP Meta-Tool Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a remote (Streamable HTTP) MCP server that exposes 116 GreenNode AgentBase REST operations through 3 meta-tools (`list_servers`, `search_tools`, `execute`) instead of 116 native tools, cutting resident tool-definition tax ~95%.

**Architecture:** A build-time generator normalizes the six swagger specs (Swagger 2.0 + OpenAPI 3.1) into one committed `registry.generated.json`. At runtime, a hand-written meta layer loads that registry, serves BM25 search over it, and forwards `execute` calls to the target service — passing the request's bearer token straight through. One deployment binds to one environment (`ENV=dev|prod`).

**Tech Stack:** TypeScript (ESM), Node ≥20, `@modelcontextprotocol/sdk`, `express`, `zod`, `jmespath` (response projection), `swagger2openapi` + `@apidevtools/swagger-parser` (build-time spec normalization), hand-rolled BM25 (no ML dep), `vitest` + `supertest` (tests), `tsx` (script/dev runner).

## Global Constraints

- Node ≥ 20 (native `fetch`, native `structuredClone`). One line: `"engines": { "node": ">=20" }`.
- ES modules only (`"type": "module"` in package.json; `"module": "NodeNext"` in tsconfig). All local imports use explicit `.js` extensions.
- `registry.generated.json` and `specs/*.json` are **generated artifacts** — never hand-edited. Only `scripts/generate-registry.ts` writes the registry; only `scripts/fetch-specs.ts` writes `specs/`.
- Every downstream HTTP call forwards the inbound request's bearer token as `Authorization: Bearer <token>`. No service credentials are stored anywhere in this server.
- Every inbound MCP request must carry a valid `X-API-Key` **and** a non-empty `Authorization: Bearer` header, or it is rejected `401` before any tool runs.
- Operation ids are always `"<service>.<operationId>"`.
- The 6 services and their tag/operation counts (for tests): policy 11, cr 13, gateway 17, identity 30, memory 16, runtime 29 → **116 total**.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working TypeScript + vitest toolchain. `npm test` runs vitest; `npm run build` type-checks.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "greennode-agentbase-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "fetch-specs": "tsx scripts/fetch-specs.ts",
    "generate-registry": "tsx scripts/generate-registry.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "express": "^5.0.0",
    "jmespath": "^0.16.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@apidevtools/swagger-parser": "^10.1.0",
    "@types/express": "^5.0.0",
    "@types/jmespath": "^0.15.2",
    "@types/node": "^20.14.0",
    "@types/supertest": "^6.0.2",
    "supertest": "^7.0.0",
    "swagger2openapi": "^7.0.8",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "scripts"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Write `.gitignore`**

```
node_modules/
dist/
*.log
.env
```

- [ ] **Step 5: Write the smoke test — `src/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";

describe("toolchain", () => {
  it("runs typescript tests", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: Install and run**

Run: `npm install && npm test`
Expected: PASS — 1 test passed.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore src/smoke.test.ts package-lock.json
git commit -m "chore: scaffold TypeScript MCP project"
```

---

### Task 2: Environment config

**Files:**
- Create: `src/config/env.ts`
- Test: `src/config/env.test.ts`

**Interfaces:**
- Consumes: `process.env`.
- Produces:
  - `type Environment = "dev" | "prod"`
  - `interface EnvConfig { environment: Environment; baseUrls: Record<string, string>; apiKeys: string[]; maxResponseBytes: number; port: number; searchLimitDefault: number; }`
  - `function loadEnvConfig(env: NodeJS.ProcessEnv): EnvConfig` — throws `Error` on invalid `ENV` or empty `API_KEYS`.
  - `const SERVICES: readonly string[]` = the 6 service names.

- [ ] **Step 1: Write the failing test — `src/config/env.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { loadEnvConfig, SERVICES } from "./env.js";

const base = { ENV: "dev", API_KEYS: "k1,k2" } as NodeJS.ProcessEnv;

describe("loadEnvConfig", () => {
  it("resolves dev base urls for all six services", () => {
    const cfg = loadEnvConfig(base);
    expect(cfg.environment).toBe("dev");
    expect(Object.keys(cfg.baseUrls).sort()).toEqual([...SERVICES].sort());
    expect(cfg.baseUrls.memory).toBe(
      "https://pub-iamapis.api-dev.vngcloud.tech/agent-core-memory",
    );
    expect(cfg.baseUrls.policy).toBe(
      "https://agentbase.api-dev.vngcloud.tech/policy",
    );
  });

  it("resolves prod base urls under agentbase.api.vngcloud.vn", () => {
    const cfg = loadEnvConfig({ ...base, ENV: "prod" });
    expect(cfg.baseUrls.memory).toBe("https://agentbase.api.vngcloud.vn/memory");
    expect(cfg.baseUrls.runtime).toBe("https://agentbase.api.vngcloud.vn/runtime");
  });

  it("parses api keys and applies defaults", () => {
    const cfg = loadEnvConfig(base);
    expect(cfg.apiKeys).toEqual(["k1", "k2"]);
    expect(cfg.maxResponseBytes).toBe(25_000);
    expect(cfg.port).toBe(8080);
    expect(cfg.searchLimitDefault).toBe(5);
  });

  it("throws on invalid ENV", () => {
    expect(() => loadEnvConfig({ ...base, ENV: "staging" })).toThrow(/ENV/);
  });

  it("throws when API_KEYS missing", () => {
    expect(() => loadEnvConfig({ ENV: "dev" } as NodeJS.ProcessEnv)).toThrow(/API_KEYS/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/config/env.test.ts`
Expected: FAIL — cannot find module `./env.js`.

- [ ] **Step 3: Implement `src/config/env.ts`**

```ts
export type Environment = "dev" | "prod";

export const SERVICES = [
  "policy",
  "cr",
  "gateway",
  "identity",
  "memory",
  "runtime",
] as const;

export type ServiceName = (typeof SERVICES)[number];

const BASE_URLS: Record<Environment, Record<ServiceName, string>> = {
  dev: {
    policy: "https://agentbase.api-dev.vngcloud.tech/policy",
    cr: "https://agentbase.api-dev.vngcloud.tech/cr",
    gateway: "https://agentbase.api-dev.vngcloud.tech/gateway",
    identity: "https://agentbase.api-dev.vngcloud.tech/identity",
    memory: "https://pub-iamapis.api-dev.vngcloud.tech/agent-core-memory",
    runtime: "https://pub-iamapis.api-dev.vngcloud.tech/agent-core-runtime",
  },
  prod: {
    policy: "https://agentbase.api.vngcloud.vn/policy",
    cr: "https://agentbase.api.vngcloud.vn/cr",
    gateway: "https://agentbase.api.vngcloud.vn/gateway",
    identity: "https://agentbase.api.vngcloud.vn/identity",
    memory: "https://agentbase.api.vngcloud.vn/memory",
    runtime: "https://agentbase.api.vngcloud.vn/runtime",
  },
};

export interface EnvConfig {
  environment: Environment;
  baseUrls: Record<string, string>;
  apiKeys: string[];
  maxResponseBytes: number;
  port: number;
  searchLimitDefault: number;
}

export function loadEnvConfig(env: NodeJS.ProcessEnv): EnvConfig {
  const raw = env.ENV ?? "dev";
  if (raw !== "dev" && raw !== "prod") {
    throw new Error(`Invalid ENV "${raw}": expected "dev" or "prod"`);
  }
  const environment = raw as Environment;

  const apiKeys = (env.API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (apiKeys.length === 0) {
    throw new Error("API_KEYS is required (comma-separated list of valid keys)");
  }

  return {
    environment,
    baseUrls: { ...BASE_URLS[environment] },
    apiKeys,
    maxResponseBytes: Number(env.MAX_RESPONSE_BYTES ?? 25_000),
    port: Number(env.PORT ?? 8080),
    searchLimitDefault: Number(env.SEARCH_LIMIT_DEFAULT ?? 5),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/config/env.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts
git commit -m "feat: environment config with per-service base URLs"
```

---

### Task 3: Registry types and loader

**Files:**
- Create: `src/registry/types.ts`
- Create: `src/registry/loader.ts`
- Test: `src/registry/loader.test.ts`

**Interfaces:**
- Consumes: nothing (types only) + a registry JSON file path.
- Produces:
  - `type JsonSchema = Record<string, any>`
  - `type ParamLocation = "path" | "query" | "header"`
  - `interface ParamSpec { name: string; location: ParamLocation; required: boolean; schema: JsonSchema; }`
  - `interface RegistryOperation { id: string; service: string; operationId: string; method: string; path: string; summary: string; tags: string[]; parameters: ParamSpec[]; hasBody: boolean; bodyRequired: boolean; inputSchema: JsonSchema; }`
  - `interface Registry { operations: RegistryOperation[]; }`
  - `interface ServerInfo { name: string; description: string; operationCount: number; tags: string[]; }`
  - `class RegistryStore` with: `static fromObject(reg: Registry): RegistryStore`, `static fromFile(path: string): RegistryStore`, `getById(id): RegistryOperation | undefined`, `all(): RegistryOperation[]`, `servers(): ServerInfo[]`.

- [ ] **Step 1: Write `src/registry/types.ts`**

```ts
export type JsonSchema = Record<string, any>;

export type ParamLocation = "path" | "query" | "header";

export interface ParamSpec {
  name: string;
  location: ParamLocation;
  required: boolean;
  schema: JsonSchema;
}

export interface RegistryOperation {
  id: string; // "<service>.<operationId>"
  service: string;
  operationId: string;
  method: string; // upper-case HTTP verb
  path: string; // e.g. "/v3/agent-runtimes/{id}"
  summary: string;
  tags: string[];
  parameters: ParamSpec[]; // path/query/header only
  hasBody: boolean;
  bodyRequired: boolean;
  inputSchema: JsonSchema; // object schema the model sees
}

export interface Registry {
  operations: RegistryOperation[];
}

export interface ServerInfo {
  name: string;
  description: string;
  operationCount: number;
  tags: string[];
}
```

- [ ] **Step 2: Write the failing test — `src/registry/loader.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { RegistryStore } from "./loader.js";
import type { Registry } from "./types.js";

const fixture: Registry = {
  operations: [
    {
      id: "runtime.createAgentRuntime",
      service: "runtime",
      operationId: "createAgentRuntime",
      method: "POST",
      path: "/v3/agent-runtimes",
      summary: "Create an agent runtime",
      tags: ["agent-runtime"],
      parameters: [],
      hasBody: true,
      bodyRequired: true,
      inputSchema: { type: "object", properties: {} },
    },
    {
      id: "runtime.listAgentRuntimes",
      service: "runtime",
      operationId: "listAgentRuntimes",
      method: "GET",
      path: "/v3/agent-runtimes",
      summary: "List agent runtimes",
      tags: ["agent-runtime"],
      parameters: [],
      hasBody: false,
      bodyRequired: false,
      inputSchema: { type: "object", properties: {} },
    },
    {
      id: "policy.listPolicies",
      service: "policy",
      operationId: "listPolicies",
      method: "GET",
      path: "/policies",
      summary: "List policies",
      tags: ["policies"],
      parameters: [],
      hasBody: false,
      bodyRequired: false,
      inputSchema: { type: "object", properties: {} },
    },
  ],
};

describe("RegistryStore", () => {
  const store = RegistryStore.fromObject(fixture);

  it("looks up an operation by id", () => {
    expect(store.getById("runtime.createAgentRuntime")?.method).toBe("POST");
    expect(store.getById("nope")).toBeUndefined();
  });

  it("groups operations into servers with counts and tags", () => {
    const servers = store.servers();
    const runtime = servers.find((s) => s.name === "runtime")!;
    expect(runtime.operationCount).toBe(2);
    expect(runtime.tags).toContain("agent-runtime");
    expect(servers.map((s) => s.name).sort()).toEqual(["policy", "runtime"]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/registry/loader.test.ts`
Expected: FAIL — cannot find module `./loader.js`.

- [ ] **Step 4: Implement `src/registry/loader.ts`**

```ts
import { readFileSync } from "node:fs";
import type { Registry, RegistryOperation, ServerInfo } from "./types.js";

export class RegistryStore {
  private byId = new Map<string, RegistryOperation>();

  private constructor(private operations: RegistryOperation[]) {
    for (const op of operations) this.byId.set(op.id, op);
  }

  static fromObject(reg: Registry): RegistryStore {
    return new RegistryStore(reg.operations);
  }

  static fromFile(path: string): RegistryStore {
    const reg = JSON.parse(readFileSync(path, "utf8")) as Registry;
    return RegistryStore.fromObject(reg);
  }

  getById(id: string): RegistryOperation | undefined {
    return this.byId.get(id);
  }

  all(): RegistryOperation[] {
    return this.operations;
  }

  servers(): ServerInfo[] {
    const map = new Map<string, { count: number; tags: Set<string> }>();
    for (const op of this.operations) {
      const entry = map.get(op.service) ?? { count: 0, tags: new Set() };
      entry.count += 1;
      for (const t of op.tags) entry.tags.add(t);
      map.set(op.service, entry);
    }
    return [...map.entries()].map(([name, e]) => ({
      name,
      description: `${name} service (${e.count} operations)`,
      operationCount: e.count,
      tags: [...e.tags].sort(),
    }));
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/registry/loader.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 6: Commit**

```bash
git add src/registry/types.ts src/registry/loader.ts src/registry/loader.test.ts
git commit -m "feat: registry types and loader"
```

---

### Task 4: Spec fetcher + registry generator

**Files:**
- Create: `scripts/fetch-specs.ts`
- Create: `scripts/spec-to-registry.ts` (pure transform, unit-tested)
- Create: `scripts/generate-registry.ts` (I/O wrapper around the transform)
- Create: `specs/README.md` (documents the committed spec fixtures)
- Test: `scripts/spec-to-registry.test.ts`
- Generated: `specs/*.json` (6 files), `registry.generated.json`

**Interfaces:**
- Consumes: `RegistryOperation`, `Registry`, `SERVICES` from earlier tasks.
- Produces:
  - `async function normalizeSpec(rawSpec: unknown): Promise<any>` — converts Swagger 2.0 → OpenAPI 3 (via `swagger2openapi`) if needed, then fully dereferences (`@apidevtools/swagger-parser`). Returns a `$ref`-free OpenAPI 3 document.
  - `function extractOperations(service: string, oas: any): RegistryOperation[]` — walks `paths × methods`.
  - `async function buildRegistry(specs: { service: string; raw: unknown }[]): Promise<Registry>`.

**Note on URL joining (read before implementing):** the generator stores each operation's `path` exactly as it appears under the spec's `paths` key. At call time the downstream URL is `baseUrl + path`. If a live smoke test (Task 11) shows a doubled path segment (e.g. `/cr/cr/...`), fix it by trimming the base URL map in `src/config/env.ts` — not by editing the generated registry.

- [ ] **Step 1: Write the failing transform test — `scripts/spec-to-registry.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { normalizeSpec, extractOperations } from "./spec-to-registry.js";

// Minimal Swagger 2.0 doc with a $ref body param.
const swagger2 = {
  swagger: "2.0",
  info: { title: "cr", version: "1" },
  paths: {
    "/credentials/{id}": {
      get: {
        operationId: "getCredential",
        summary: "Get a credential",
        tags: ["Registry Credential"],
        parameters: [
          { name: "id", in: "path", required: true, type: "string" },
          { name: "verbose", in: "query", required: false, type: "boolean" },
        ],
      },
      post: {
        operationId: "updateCredential",
        summary: "Update a credential",
        tags: ["Registry Credential"],
        parameters: [
          { name: "id", in: "path", required: true, type: "string" },
          {
            name: "body",
            in: "body",
            required: true,
            schema: { $ref: "#/definitions/Cred" },
          },
        ],
      },
    },
  },
  definitions: {
    Cred: {
      type: "object",
      properties: { username: { type: "string" }, password: { type: "string" } },
    },
  },
};

describe("normalizeSpec + extractOperations", () => {
  it("converts swagger 2.0, dereferences, and extracts operations", async () => {
    const oas = await normalizeSpec(swagger2);
    const ops = extractOperations("cr", oas);

    expect(ops.map((o) => o.id).sort()).toEqual([
      "cr.getCredential",
      "cr.updateCredential",
    ]);

    const get = ops.find((o) => o.id === "cr.getCredential")!;
    expect(get.method).toBe("GET");
    expect(get.path).toBe("/credentials/{id}");
    expect(get.hasBody).toBe(false);
    const idParam = get.parameters.find((p) => p.name === "id")!;
    expect(idParam.location).toBe("path");
    expect(idParam.required).toBe(true);
    // path/query params surface as inputSchema properties
    expect(get.inputSchema.properties.id).toBeDefined();
    expect(get.inputSchema.properties.verbose).toBeDefined();
    expect(get.inputSchema.required).toContain("id");

    const post = ops.find((o) => o.id === "cr.updateCredential")!;
    expect(post.hasBody).toBe(true);
    expect(post.bodyRequired).toBe(true);
    // dereferenced body schema is inlined under the "body" property
    expect(post.inputSchema.properties.body.properties.username).toBeDefined();
    expect(post.inputSchema.required).toContain("body");
  });

  it("extracts OpenAPI 3 requestBody operations", async () => {
    const oas3 = {
      openapi: "3.0.0",
      info: { title: "runtime", version: "1" },
      paths: {
        "/v3/agent-runtimes": {
          post: {
            operationId: "createAgentRuntime",
            summary: "Create runtime",
            tags: ["agent-runtime"],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { name: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    };
    const oas = await normalizeSpec(oas3);
    const ops = extractOperations("runtime", oas);
    expect(ops[0].id).toBe("runtime.createAgentRuntime");
    expect(ops[0].hasBody).toBe(true);
    expect(ops[0].inputSchema.properties.body.properties.name).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run scripts/spec-to-registry.test.ts`
Expected: FAIL — cannot find module `./spec-to-registry.js`.

- [ ] **Step 3: Implement `scripts/spec-to-registry.ts`**

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run scripts/spec-to-registry.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Implement the fetcher — `scripts/fetch-specs.ts`**

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPECS_DIR = join(HERE, "..", "specs");

// Dev spec URLs (source of truth for the committed fixtures).
const SPEC_URLS: Record<string, string> = {
  policy: "https://agentbase.api-dev.vngcloud.tech/policy/swagger/doc.json",
  cr: "https://agentbase.api-dev.vngcloud.tech/cr/swagger/doc.json",
  gateway: "https://agentbase.api-dev.vngcloud.tech/gateway/swagger/doc.json",
  identity: "https://agentbase.api-dev.vngcloud.tech/identity/api-docs",
  memory:
    "https://pub-iamapis.api-dev.vngcloud.tech/agent-core-memory/v3/api-docs",
  runtime:
    "https://pub-iamapis.api-dev.vngcloud.tech/agent-core-runtime/v3/api-docs",
};

async function main() {
  mkdirSync(SPECS_DIR, { recursive: true });
  for (const [service, url] of Object.entries(SPEC_URLS)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${service}: HTTP ${res.status} from ${url}`);
    const json = await res.json();
    const dest = join(SPECS_DIR, `${service}.json`);
    writeFileSync(dest, JSON.stringify(json, null, 2));
    console.log(`wrote ${dest}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 6: Implement the generator — `scripts/generate-registry.ts`**

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICES } from "../src/config/env.js";
import { buildRegistry } from "./spec-to-registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPECS_DIR = join(HERE, "..", "specs");
const OUT = join(HERE, "..", "registry.generated.json");

async function main() {
  const specs = SERVICES.map((service) => ({
    service,
    raw: JSON.parse(readFileSync(join(SPECS_DIR, `${service}.json`), "utf8")),
  }));
  const registry = await buildRegistry(specs);
  writeFileSync(OUT, JSON.stringify(registry, null, 2));
  console.log(`wrote ${OUT} with ${registry.operations.length} operations`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 7: Write `specs/README.md`**

```markdown
# specs/

Committed swagger/OpenAPI fixtures — **generated, do not hand-edit**.

- Refresh from dev: `npm run fetch-specs`
- Rebuild the registry: `npm run generate-registry`

Sources: policy/cr/gateway = Swagger 2.0; identity/memory/runtime = OpenAPI 3.1.
```

- [ ] **Step 8: Fetch specs and generate the registry**

Run: `npm run fetch-specs && npm run generate-registry`
Expected: `wrote .../registry.generated.json with 116 operations`.

The six dev endpoints are confirmed reachable. If `npm run fetch-specs` fails in your environment, report status NEEDS_CONTEXT — do not silently substitute manual fixtures or skip Step 9's test.

- [ ] **Step 9: Add a registry count assertion test — append to `scripts/spec-to-registry.test.ts`**

The dev spec endpoints are reachable (verified during planning: all 6 return HTTP 200). Step 8 must actually succeed — do not treat a fetch failure as an environment limitation to silently work around; if `npm run fetch-specs` fails, report BLOCKED/NEEDS_CONTEXT instead of skipping this test.

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("generated registry artifact", () => {
  it("contains 116 operations across 6 services", () => {
    const path = join(process.cwd(), "registry.generated.json");
    const reg = JSON.parse(readFileSync(path, "utf8"));
    expect(reg.operations.length).toBe(116);
    const services = new Set(reg.operations.map((o: any) => o.service));
    expect([...services].sort()).toEqual(
      ["cr", "gateway", "identity", "memory", "policy", "runtime"].sort(),
    );
  });
});
```

- [ ] **Step 10: Run the full suite**

Run: `npx vitest run scripts/spec-to-registry.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 11: Commit**

```bash
git add scripts/fetch-specs.ts scripts/spec-to-registry.ts scripts/generate-registry.ts scripts/spec-to-registry.test.ts specs/ registry.generated.json
git commit -m "feat: spec fetcher and registry generator (Swagger 2.0 + OpenAPI 3)"
```

---

### Task 5: BM25 index

**Files:**
- Create: `src/search/bm25.ts`
- Test: `src/search/bm25.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `function tokenize(text: string): string[]` — lowercases, splits on non-alphanumeric, and splits camelCase (`createAgentRuntime` → `create agent runtime`).
  - `interface Bm25Doc { id: string; text: string; }`
  - `interface Bm25Hit { id: string; score: number; }`
  - `class Bm25Index { constructor(docs: Bm25Doc[]); query(q: string, limit: number): Bm25Hit[]; }`

- [ ] **Step 1: Write the failing test — `src/search/bm25.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { tokenize, Bm25Index } from "./bm25.js";

describe("tokenize", () => {
  it("splits camelCase and punctuation, lowercases", () => {
    expect(tokenize("createAgentRuntime")).toEqual(["create", "agent", "runtime"]);
    expect(tokenize("Registry Credential (Admin)")).toEqual([
      "registry",
      "credential",
      "admin",
    ]);
  });
});

describe("Bm25Index", () => {
  const index = new Bm25Index([
    { id: "runtime.createAgentRuntime", text: "create an agent runtime POST /v3/agent-runtimes" },
    { id: "runtime.listAgentRuntimes", text: "list agent runtimes GET /v3/agent-runtimes" },
    { id: "cr.getCredential", text: "get registry credential GET /credentials" },
  ]);

  it("ranks the most relevant doc first", () => {
    const hits = index.query("create runtime", 5);
    expect(hits[0].id).toBe("runtime.createAgentRuntime");
  });

  it("respects the limit", () => {
    const hits = index.query("agent", 1);
    expect(hits.length).toBe(1);
  });

  it("returns empty for no term overlap", () => {
    expect(index.query("zzzznotaword", 5)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/search/bm25.test.ts`
Expected: FAIL — cannot find module `./bm25.js`.

- [ ] **Step 3: Implement `src/search/bm25.ts`**

```ts
export function tokenize(text: string): string[] {
  return text
    // split camelCase boundaries: "createAgent" -> "create Agent"
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export interface Bm25Doc {
  id: string;
  text: string;
}

export interface Bm25Hit {
  id: string;
  score: number;
}

const K1 = 1.5;
const B = 0.75;

export class Bm25Index {
  private docs: { id: string; terms: Map<string, number>; length: number }[] = [];
  private df = new Map<string, number>();
  private avgLen = 0;

  constructor(docs: Bm25Doc[]) {
    for (const d of docs) {
      const tokens = tokenize(d.text);
      const terms = new Map<string, number>();
      for (const t of tokens) terms.set(t, (terms.get(t) ?? 0) + 1);
      for (const t of terms.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ id: d.id, terms, length: tokens.length });
    }
    const total = this.docs.reduce((s, d) => s + d.length, 0);
    this.avgLen = this.docs.length ? total / this.docs.length : 0;
  }

  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  query(q: string, limit: number): Bm25Hit[] {
    const qterms = tokenize(q);
    const scored: Bm25Hit[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const term of qterms) {
        const tf = doc.terms.get(term);
        if (!tf) continue;
        const idf = this.idf(term);
        const denom = tf + K1 * (1 - B + (B * doc.length) / this.avgLen);
        score += idf * ((tf * (K1 + 1)) / denom);
      }
      if (score > 0) scored.push({ id: doc.id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/search/bm25.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/search/bm25.ts src/search/bm25.test.ts
git commit -m "feat: hand-rolled BM25 index with camelCase tokenization"
```

---

### Task 6: Search engine

**Files:**
- Create: `src/search/engine.ts`
- Test: `src/search/engine.test.ts`

**Interfaces:**
- Consumes: `RegistryOperation` (Task 3), `Bm25Index` (Task 5).
- Produces:
  - `interface SearchHit { id: string; service: string; summary: string; inputSchema: JsonSchema; }`
  - `interface SearchOptions { server?: string; limit?: number; }`
  - `interface SearchEngine { search(query: string, opts?: SearchOptions): SearchHit[]; }`
  - `class Bm25SearchEngine implements SearchEngine { constructor(ops: RegistryOperation[], defaultLimit?: number); }`

- [ ] **Step 1: Write the failing test — `src/search/engine.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { Bm25SearchEngine } from "./engine.js";
import type { RegistryOperation } from "../registry/types.js";

function op(partial: Partial<RegistryOperation>): RegistryOperation {
  return {
    id: "x.y",
    service: "x",
    operationId: "y",
    method: "GET",
    path: "/y",
    summary: "",
    tags: [],
    parameters: [],
    hasBody: false,
    bodyRequired: false,
    inputSchema: { type: "object", properties: {} },
    ...partial,
  };
}

const ops = [
  op({ id: "runtime.createAgentRuntime", service: "runtime", operationId: "createAgentRuntime", method: "POST", path: "/v3/agent-runtimes", summary: "Create an agent runtime", tags: ["agent-runtime"] }),
  op({ id: "runtime.listAgentRuntimes", service: "runtime", operationId: "listAgentRuntimes", path: "/v3/agent-runtimes", summary: "List agent runtimes", tags: ["agent-runtime"] }),
  op({ id: "cr.getCredential", service: "cr", operationId: "getCredential", path: "/credentials", summary: "Get registry credential", tags: ["Registry Credential"] }),
];

describe("Bm25SearchEngine", () => {
  const engine = new Bm25SearchEngine(ops, 5);

  it("returns rich hits with inputSchema inline", () => {
    const hits = engine.search("create agent runtime");
    expect(hits[0].id).toBe("runtime.createAgentRuntime");
    expect(hits[0].inputSchema).toBeDefined();
    expect(hits[0].service).toBe("runtime");
  });

  it("scopes results to a server when given", () => {
    const hits = engine.search("credential", { server: "runtime" });
    expect(hits.every((h) => h.service === "runtime")).toBe(true);
  });

  it("honors an explicit limit", () => {
    const hits = engine.search("agent", { limit: 1 });
    expect(hits.length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/search/engine.test.ts`
Expected: FAIL — cannot find module `./engine.js`.

- [ ] **Step 3: Implement `src/search/engine.ts`**

```ts
import type { JsonSchema, RegistryOperation } from "../registry/types.js";
import { Bm25Index } from "./bm25.js";

export interface SearchHit {
  id: string;
  service: string;
  summary: string;
  inputSchema: JsonSchema;
}

export interface SearchOptions {
  server?: string;
  limit?: number;
}

export interface SearchEngine {
  search(query: string, opts?: SearchOptions): SearchHit[];
}

export class Bm25SearchEngine implements SearchEngine {
  private index: Bm25Index;
  private byId: Map<string, RegistryOperation>;

  constructor(
    private ops: RegistryOperation[],
    private defaultLimit = 5,
  ) {
    this.byId = new Map(ops.map((o) => [o.id, o]));
    this.index = new Bm25Index(
      ops.map((o) => ({
        id: o.id,
        text: `${o.operationId} ${o.summary} ${o.tags.join(" ")} ${o.path} ${o.service}`,
      })),
    );
  }

  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const limit = opts.limit ?? this.defaultLimit;
    // Over-fetch so the server filter still yields up to `limit` hits.
    const raw = this.index.query(query, opts.server ? limit * 5 : limit);
    const hits: SearchHit[] = [];
    for (const { id } of raw) {
      const op = this.byId.get(id);
      if (!op) continue;
      if (opts.server && op.service !== opts.server) continue;
      hits.push({
        id: op.id,
        service: op.service,
        summary: op.summary,
        inputSchema: op.inputSchema,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/search/engine.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/search/engine.ts src/search/engine.test.ts
git commit -m "feat: registry-backed BM25 search engine"
```

---

### Task 7: Response projection + byte cap

**Files:**
- Create: `src/filter/project.ts`
- Test: `src/filter/project.test.ts`

**Interfaces:**
- Consumes: `jmespath`.
- Produces:
  - `interface ProjectResult { text: string; truncated: boolean; }`
  - `function projectAndCap(data: unknown, fields: string | undefined, maxBytes: number): ProjectResult` — applies a JMESPath expression when `fields` is set, serializes to JSON, and truncates to `maxBytes` with a notice appended.

- [ ] **Step 1: Write the failing test — `src/filter/project.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { projectAndCap } from "./project.js";

const data = {
  items: [
    { id: "a", name: "Alpha", status: "RUNNING", secret: "x" },
    { id: "b", name: "Beta", status: "STOPPED", secret: "y" },
  ],
};

describe("projectAndCap", () => {
  it("returns full JSON when no fields given", () => {
    const r = projectAndCap(data, undefined, 25_000);
    expect(r.truncated).toBe(false);
    expect(JSON.parse(r.text)).toEqual(data);
  });

  it("applies a JMESPath projection", () => {
    const r = projectAndCap(
      data,
      "items[].{id: id, name: name, status: status}",
      25_000,
    );
    const parsed = JSON.parse(r.text);
    expect(parsed).toEqual([
      { id: "a", name: "Alpha", status: "RUNNING" },
      { id: "b", name: "Beta", status: "STOPPED" },
    ]);
  });

  it("truncates oversized output and flags it", () => {
    const big = { blob: "z".repeat(1000) };
    const r = projectAndCap(big, undefined, 100);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("[truncated");
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThan(300);
  });

  it("reports a clear error for an invalid JMESPath expression", () => {
    const r = projectAndCap(data, "items[.broken", 25_000);
    expect(r.text).toContain("invalid fields expression");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/filter/project.test.ts`
Expected: FAIL — cannot find module `./project.js`.

- [ ] **Step 3: Implement `src/filter/project.ts`**

```ts
import jmespath from "jmespath";

export interface ProjectResult {
  text: string;
  truncated: boolean;
}

export function projectAndCap(
  data: unknown,
  fields: string | undefined,
  maxBytes: number,
): ProjectResult {
  let value: unknown = data;
  if (fields) {
    try {
      value = jmespath.search(data, fields);
    } catch (e) {
      return {
        text: `invalid fields expression: ${(e as Error).message}`,
        truncated: false,
      };
    }
  }

  const json = JSON.stringify(value ?? null);
  if (Buffer.byteLength(json, "utf8") <= maxBytes) {
    return { text: json, truncated: false };
  }

  const notice = " …[truncated — narrow with fields/pagination]";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(notice, "utf8"));
  const sliced = Buffer.from(json, "utf8").subarray(0, budget).toString("utf8");
  return { text: sliced + notice, truncated: true };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/filter/project.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/filter/project.ts src/filter/project.test.ts
git commit -m "feat: JMESPath response projection with byte cap"
```

---

### Task 8: Downstream HTTP caller

**Files:**
- Create: `src/http/downstream.ts`
- Test: `src/http/downstream.test.ts`

**Interfaces:**
- Consumes: `RegistryOperation` (Task 3).
- Produces:
  - `type FetchLike = (url: string, init?: any) => Promise<{ status: number; text(): Promise<string>; headers: { get(name: string): string | null } }>`
  - `interface DownstreamRequest { op: RegistryOperation; args: Record<string, any>; baseUrl: string; bearerToken: string; }`
  - `interface DownstreamResponse { status: number; body: unknown; }`
  - `async function callDownstream(req: DownstreamRequest, fetchImpl?: FetchLike): Promise<DownstreamResponse>` — binds args to path/query/header/body, forwards the bearer token, parses JSON (falls back to raw text).

- [ ] **Step 1: Write the failing test — `src/http/downstream.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { callDownstream } from "./downstream.js";
import type { RegistryOperation } from "../registry/types.js";

const baseOp: RegistryOperation = {
  id: "runtime.getAgentRuntime",
  service: "runtime",
  operationId: "getAgentRuntime",
  method: "GET",
  path: "/v3/agent-runtimes/{id}",
  summary: "Get runtime",
  tags: [],
  parameters: [
    { name: "id", location: "path", required: true, schema: { type: "string" } },
    { name: "expand", location: "query", required: false, schema: { type: "string" } },
  ],
  hasBody: false,
  bodyRequired: false,
  inputSchema: { type: "object", properties: {} },
};

function fakeFetch(capture: any) {
  return async (url: string, init?: any) => {
    capture.url = url;
    capture.init = init;
    return {
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ id: "r1", status: "RUNNING" }),
    };
  };
}

describe("callDownstream", () => {
  it("substitutes path params, appends query, forwards bearer", async () => {
    const cap: any = {};
    const res = await callDownstream(
      { op: baseOp, args: { id: "r1", expand: "traces" }, baseUrl: "https://h/runtime", bearerToken: "TKN" },
      fakeFetch(cap),
    );
    expect(cap.url).toBe("https://h/runtime/v3/agent-runtimes/r1?expand=traces");
    expect(cap.init.method).toBe("GET");
    expect(cap.init.headers.Authorization).toBe("Bearer TKN");
    expect(res.body).toEqual({ id: "r1", status: "RUNNING" });
  });

  it("sends a JSON body for body operations", async () => {
    const cap: any = {};
    const postOp: RegistryOperation = {
      ...baseOp,
      id: "runtime.createAgentRuntime",
      operationId: "createAgentRuntime",
      method: "POST",
      path: "/v3/agent-runtimes",
      parameters: [],
      hasBody: true,
      bodyRequired: true,
    };
    await callDownstream(
      { op: postOp, args: { body: { name: "r" } }, baseUrl: "https://h/runtime", bearerToken: "TKN" },
      fakeFetch(cap),
    );
    expect(cap.init.method).toBe("POST");
    expect(cap.init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(cap.init.body)).toEqual({ name: "r" });
  });

  it("returns raw text when response is not JSON", async () => {
    const notJson = async () => ({
      status: 204,
      headers: { get: () => "text/plain" },
      text: async () => "",
    });
    const res = await callDownstream(
      { op: baseOp, args: { id: "r1" }, baseUrl: "https://h/runtime", bearerToken: "T" },
      notJson as any,
    );
    expect(res.status).toBe(204);
    expect(res.body).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/http/downstream.test.ts`
Expected: FAIL — cannot find module `./downstream.js`.

- [ ] **Step 3: Implement `src/http/downstream.ts`**

```ts
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
    if (val === undefined || val === null) continue;
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/http/downstream.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/http/downstream.ts src/http/downstream.test.ts
git commit -m "feat: downstream HTTP caller with arg binding and token pass-through"
```

---

### Task 9: Inbound auth

**Files:**
- Create: `src/auth/inbound.ts`
- Test: `src/auth/inbound.test.ts`

**Interfaces:**
- Consumes: `EnvConfig` (Task 2).
- Produces:
  - `interface AuthContext { bearerToken: string; }`
  - `class AuthError extends Error { readonly status: number; constructor(status: number, message: string); }`
  - `function authenticate(headers: Record<string, string | string[] | undefined>, apiKeys: string[]): AuthContext` — throws `AuthError(401, …)` when the api key is missing/invalid or the bearer token is absent.

- [ ] **Step 1: Write the failing test — `src/auth/inbound.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { authenticate, AuthError } from "./inbound.js";

const keys = ["good-key"];

describe("authenticate", () => {
  it("returns the bearer token on valid api key + bearer", () => {
    const ctx = authenticate(
      { "x-api-key": "good-key", authorization: "Bearer ABC" },
      keys,
    );
    expect(ctx.bearerToken).toBe("ABC");
  });

  it("rejects a missing/invalid api key with 401", () => {
    expect(() =>
      authenticate({ authorization: "Bearer ABC" }, keys),
    ).toThrow(AuthError);
    try {
      authenticate({ "x-api-key": "bad", authorization: "Bearer ABC" }, keys);
    } catch (e) {
      expect((e as AuthError).status).toBe(401);
      expect((e as AuthError).message).toMatch(/api key/i);
    }
  });

  it("rejects a missing bearer token with 401 'missing upstream token'", () => {
    try {
      authenticate({ "x-api-key": "good-key" }, keys);
    } catch (e) {
      expect((e as AuthError).status).toBe(401);
      expect((e as AuthError).message).toMatch(/missing upstream token/i);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/auth/inbound.test.ts`
Expected: FAIL — cannot find module `./inbound.js`.

- [ ] **Step 3: Implement `src/auth/inbound.ts`**

```ts
export interface AuthContext {
  bearerToken: string;
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export function authenticate(headers: Headers, apiKeys: string[]): AuthContext {
  const apiKey = header(headers, "x-api-key");
  if (!apiKey || !apiKeys.includes(apiKey)) {
    throw new AuthError(401, "invalid or missing api key");
  }

  const auth = header(headers, "authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!match || !match[1]) {
    throw new AuthError(401, "missing upstream token");
  }

  return { bearerToken: match[1] };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/auth/inbound.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/auth/inbound.ts src/auth/inbound.test.ts
git commit -m "feat: inbound api-key + bearer-presence authentication"
```

---

### Task 10: Meta-tool handlers

**Files:**
- Create: `src/meta-tools/handlers.ts`
- Test: `src/meta-tools/handlers.test.ts`

**Interfaces:**
- Consumes: `RegistryStore` (Task 3), `SearchEngine` (Task 6), `projectAndCap` (Task 7), `callDownstream` + `FetchLike` (Task 8), `AuthContext` (Task 9), `EnvConfig` (Task 2).
- Produces:
  - `interface ToolResult { content: { type: "text"; text: string }[]; isError?: boolean; }`
  - `interface HandlerDeps { registry: RegistryStore; engine: SearchEngine; config: EnvConfig; fetchImpl?: FetchLike; }`
  - `function listServers(deps: HandlerDeps): ToolResult`
  - `function searchTools(deps: HandlerDeps, args: { query: string; server?: string; limit?: number }): ToolResult`
  - `async function executeTool(deps: HandlerDeps, auth: AuthContext, args: { id: string; args?: Record<string, any>; fields?: string }): Promise<ToolResult>`

- [ ] **Step 1: Write the failing test — `src/meta-tools/handlers.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { listServers, searchTools, executeTool } from "./handlers.js";
import type { HandlerDeps } from "./handlers.js";
import { RegistryStore } from "../registry/loader.js";
import { Bm25SearchEngine } from "../search/engine.js";
import type { Registry } from "../registry/types.js";

const reg: Registry = {
  operations: [
    {
      id: "runtime.getAgentRuntime",
      service: "runtime",
      operationId: "getAgentRuntime",
      method: "GET",
      path: "/v3/agent-runtimes/{id}",
      summary: "Get agent runtime",
      tags: ["agent-runtime"],
      parameters: [
        { name: "id", location: "path", required: true, schema: { type: "string" } },
      ],
      hasBody: false,
      bodyRequired: false,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  ],
};

function deps(fetchImpl?: any): HandlerDeps {
  const store = RegistryStore.fromObject(reg);
  return {
    registry: store,
    engine: new Bm25SearchEngine(store.all(), 5),
    config: {
      environment: "dev",
      baseUrls: { runtime: "https://h/runtime" },
      apiKeys: ["k"],
      maxResponseBytes: 25_000,
      port: 8080,
      searchLimitDefault: 5,
    },
    fetchImpl,
  };
}

describe("meta-tool handlers", () => {
  it("list_servers reports the runtime service", () => {
    const r = listServers(deps());
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.find((s: any) => s.name === "runtime").operationCount).toBe(1);
  });

  it("search_tools returns a rich hit with inputSchema", () => {
    const r = searchTools(deps(), { query: "get agent runtime" });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed[0].id).toBe("runtime.getAgentRuntime");
    expect(parsed[0].inputSchema.required).toContain("id");
  });

  it("execute calls downstream with the bearer token and projects fields", async () => {
    const cap: any = {};
    const fetchImpl = async (url: string, init: any) => {
      cap.url = url;
      cap.auth = init.headers.Authorization;
      return {
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ id: "r1", status: "RUNNING", secret: "x" }),
      };
    };
    const r = await executeTool(deps(fetchImpl), { bearerToken: "TKN" }, {
      id: "runtime.getAgentRuntime",
      args: { id: "r1" },
      fields: "{id: id, status: status}",
    });
    expect(cap.url).toBe("https://h/runtime/v3/agent-runtimes/r1");
    expect(cap.auth).toBe("Bearer TKN");
    expect(JSON.parse(r.content[0].text)).toEqual({ id: "r1", status: "RUNNING" });
  });

  it("execute returns an error result for an unknown id", async () => {
    const r = await executeTool(deps(), { bearerToken: "T" }, { id: "nope.nope" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/unknown operation/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/meta-tools/handlers.test.ts`
Expected: FAIL — cannot find module `./handlers.js`.

- [ ] **Step 3: Implement `src/meta-tools/handlers.ts`**

```ts
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
    const payload = `HTTP ${res.status}\n${projected.text}`;
    return text(payload, isError);
  } catch (e) {
    return text(`downstream call failed: ${(e as Error).message}`, true);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/meta-tools/handlers.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/meta-tools/handlers.ts src/meta-tools/handlers.test.ts
git commit -m "feat: list_servers, search_tools, execute meta-tool handlers"
```

---

### Task 11: MCP server assembly + HTTP transport

**Files:**
- Create: `src/server.ts` (registers the 3 tools on an `McpServer`)
- Create: `src/app.ts` (express app factory: `/healthz`, `/mcp` route, auth gate — no `listen()`, so it's testable with supertest)
- Create: `src/index.ts` (thin bootstrap: builds deps from env, calls `createApp`, calls `listen`)
- Test: `src/server.test.ts` (in-memory MCP client round-trip)
- Test: `src/app.test.ts` (supertest: asserts the auth gate rejects/admits correctly)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `interface ServerDeps { registry: RegistryStore; engine: SearchEngine; config: EnvConfig; fetchImpl?: FetchLike; }`
  - `function createMcpServer(deps: ServerDeps, auth: AuthContext): McpServer`
  - `interface AppDeps { registry: RegistryStore; engine: SearchEngine; config: EnvConfig; fetchImpl?: FetchLike; }`
  - `function createApp(deps: AppDeps): express.Express` — exposes `GET /healthz` and `POST /mcp`; the `/mcp` route runs `authenticate()` before touching the MCP transport and responds `401` with `{ error: string }` on failure.
  - `index.ts` boots the HTTP server on `config.port` using `createApp`.

- [ ] **Step 1: Write the failing test — `src/server.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type ServerDeps } from "./server.js";
import { RegistryStore } from "./registry/loader.js";
import { Bm25SearchEngine } from "./search/engine.js";
import type { Registry } from "./registry/types.js";

const reg: Registry = {
  operations: [
    {
      id: "runtime.listAgentRuntimes",
      service: "runtime",
      operationId: "listAgentRuntimes",
      method: "GET",
      path: "/v3/agent-runtimes",
      summary: "List agent runtimes",
      tags: ["agent-runtime"],
      parameters: [],
      hasBody: false,
      bodyRequired: false,
      inputSchema: { type: "object", properties: {} },
    },
  ],
};

function deps(): ServerDeps {
  const store = RegistryStore.fromObject(reg);
  return {
    registry: store,
    engine: new Bm25SearchEngine(store.all(), 5),
    config: {
      environment: "dev",
      baseUrls: { runtime: "https://h/runtime" },
      apiKeys: ["k"],
      maxResponseBytes: 25_000,
      port: 8080,
      searchLimitDefault: 5,
    },
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify([{ id: "r1" }]),
    }),
  };
}

describe("createMcpServer", () => {
  it("exposes exactly the 3 meta-tools and runs them end to end", async () => {
    const server = createMcpServer(deps(), { bearerToken: "TKN" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "execute",
      "list_servers",
      "search_tools",
    ]);

    const search = await client.callTool({
      name: "search_tools",
      arguments: { query: "list agent runtimes" },
    });
    const hits = JSON.parse((search.content as any)[0].text);
    expect(hits[0].id).toBe("runtime.listAgentRuntimes");

    const exec = await client.callTool({
      name: "execute",
      arguments: { id: "runtime.listAgentRuntimes", args: {} },
    });
    expect((exec.content as any)[0].text).toContain("HTTP 200");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/server.test.ts`
Expected: FAIL — cannot find module `./server.js`.

- [ ] **Step 3: Implement `src/server.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EnvConfig } from "./config/env.js";
import type { RegistryStore } from "./registry/loader.js";
import type { SearchEngine } from "./search/engine.js";
import type { FetchLike } from "./http/downstream.js";
import type { AuthContext } from "./auth/inbound.js";
import {
  listServers,
  searchTools,
  executeTool,
  type HandlerDeps,
} from "./meta-tools/handlers.js";

export interface ServerDeps {
  registry: RegistryStore;
  engine: SearchEngine;
  config: EnvConfig;
  fetchImpl?: FetchLike;
}

export function createMcpServer(
  deps: ServerDeps,
  auth: AuthContext,
): McpServer {
  const handlerDeps: HandlerDeps = deps;
  const server = new McpServer({
    name: "greennode-agentbase-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "list_servers",
    {
      description:
        "List the available AgentBase services with operation counts and tags. Call this first to orient.",
      inputSchema: {},
    },
    async () => listServers(handlerDeps),
  );

  server.registerTool(
    "search_tools",
    {
      description:
        "Search for API operations by intent. Returns matches with their full input schema inline, ready to pass to execute. Optionally scope to one server.",
      inputSchema: {
        query: z.string().describe("Natural-language description of the operation you need"),
        server: z
          .string()
          .optional()
          .describe("Optional service name to scope the search"),
        limit: z.number().int().positive().max(25).optional(),
      },
    },
    async (args) => searchTools(handlerDeps, args),
  );

  server.registerTool(
    "execute",
    {
      description:
        "Execute an API operation by id (from search_tools). Pass args matching its inputSchema. Optional 'fields' is a JMESPath expression that projects the response to reduce size.",
      inputSchema: {
        id: z.string().describe("Operation id, e.g. runtime.createAgentRuntime"),
        args: z.record(z.any()).optional(),
        fields: z
          .string()
          .optional()
          .describe("JMESPath projection over the response"),
      },
    },
    async (args) => executeTool(handlerDeps, auth, args),
  );

  return server;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/server.test.ts`
Expected: PASS — 1 test.

- [ ] **Step 5: Implement `src/app.ts`**

```ts
import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { EnvConfig } from "./config/env.js";
import type { RegistryStore } from "./registry/loader.js";
import type { SearchEngine } from "./search/engine.js";
import type { FetchLike } from "./http/downstream.js";
import { authenticate, AuthError } from "./auth/inbound.js";
import { createMcpServer } from "./server.js";

export interface AppDeps {
  registry: RegistryStore;
  engine: SearchEngine;
  config: EnvConfig;
  fetchImpl?: FetchLike;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.get("/healthz", (_req, res) =>
    res.json({ ok: true, env: deps.config.environment }),
  );

  app.post("/mcp", async (req, res) => {
    let auth;
    try {
      auth = authenticate(req.headers as any, deps.config.apiKeys);
    } catch (e) {
      const err = e as AuthError;
      res.status(err.status ?? 401).json({ error: err.message });
      return;
    }

    // Stateless: one server + transport per request.
    const server = createMcpServer(deps, auth);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}
```

- [ ] **Step 6: Write failing `src/app.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { RegistryStore } from "./registry/loader.js";
import { Bm25SearchEngine } from "./search/engine.js";
import type { Registry } from "./registry/types.js";

const reg: Registry = { operations: [] };

function testApp() {
  const store = RegistryStore.fromObject(reg);
  return createApp({
    registry: store,
    engine: new Bm25SearchEngine(store.all(), 5),
    config: {
      environment: "dev",
      baseUrls: {},
      apiKeys: ["good-key"],
      maxResponseBytes: 25_000,
      port: 8080,
      searchLimitDefault: 5,
    },
  });
}

describe("createApp auth gate", () => {
  it("responds ok on /healthz without auth", async () => {
    const res = await request(testApp()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, env: "dev" });
  });

  it("rejects /mcp with 401 when the api key is missing", async () => {
    const res = await request(testApp())
      .post("/mcp")
      .set("Authorization", "Bearer T")
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/api key/i);
  });

  it("rejects /mcp with 401 when the api key is invalid", async () => {
    const res = await request(testApp())
      .post("/mcp")
      .set("X-API-Key", "wrong-key")
      .set("Authorization", "Bearer T")
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/api key/i);
  });

  it("rejects /mcp with 401 when the bearer token is missing", async () => {
    const res = await request(testApp())
      .post("/mcp")
      .set("X-API-Key", "good-key")
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing upstream token/i);
  });

  it("passes the auth gate with valid api key and bearer token", async () => {
    const res = await request(testApp())
      .post("/mcp")
      .set("X-API-Key", "good-key")
      .set("Authorization", "Bearer T")
      .send({});
    // Past the auth gate: never 401. The exact status depends on MCP
    // transport/JSON-RPC handling of the body, which is covered separately
    // by server.test.ts's in-memory round-trip.
    expect(res.status).not.toBe(401);
  });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `npx vitest run src/app.test.ts`
Expected: FAIL — cannot find module `./app.js`.

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run src/app.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 9: Implement thin `src/index.ts`**

```ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "./config/env.js";
import { RegistryStore } from "./registry/loader.js";
import { Bm25SearchEngine } from "./search/engine.js";
import { createApp } from "./app.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const config = loadEnvConfig(process.env);
const registry = RegistryStore.fromFile(
  join(HERE, "..", "registry.generated.json"),
);
const engine = new Bm25SearchEngine(registry.all(), config.searchLimitDefault);

const app = createApp({ registry, engine, config });

app.listen(config.port, () => {
  console.log(
    `greennode-agentbase-mcp listening on :${config.port} (env=${config.environment})`,
  );
});
```

- [ ] **Step 10: Type-check the whole project**

Run: `npm run build`
Expected: no type errors.

- [ ] **Step 11: Boot smoke test**

Run: `ENV=dev API_KEYS=test-key npm start` (in one terminal), then in another:
`curl -s localhost:8080/healthz`
Expected: `{"ok":true,"env":"dev"}`. Stop the server after.

- [ ] **Step 12: Live downstream smoke test (verifies URL joining)**

With a real dev bearer token available, run a search + execute against a safe read-only op (e.g. `runtime.listAgentRuntimes` or a list endpoint). Confirm the response is a real API payload and not a 404 from a doubled path segment. If you see a doubled segment (e.g. `/runtime/agent-core-runtime/...`), adjust the base URL map in `src/config/env.ts` and re-run. If you have no bearer token available, report this step as skipped (not failed) in your DONE report — this step needs a live credential that only the human partner can supply.

- [ ] **Step 13: Run the full test suite**

Run: `npm test`
Expected: PASS — all tests across all files.

- [ ] **Step 14: Commit**

```bash
git add src/server.ts src/app.ts src/index.ts src/server.test.ts src/app.test.ts
git commit -m "feat: assemble MCP server with Streamable HTTP transport and auth"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Two-layer architecture (generated registry + meta layer) | Tasks 3, 4 (generated) + 5–11 (meta) |
| `list_servers` / `search_tools` (rich) / `execute` | Tasks 10, 11 |
| 2-step discovery (schema inline in search) | Tasks 6, 10 |
| BM25 search, pluggable `SearchEngine` | Tasks 5, 6 |
| Response `fields` projection + byte cap | Task 7 |
| Inbound api-key + require bearer | Task 9 (unit), Task 11 (HTTP-level auth gate via supertest) |
| Downstream single-token pass-through | Tasks 8, 10 |
| `ENV=dev\|prod` base URL resolution | Task 2 |
| Build-time registry generation (Swagger 2.0 + OAS3) | Task 4 |
| TypeScript / Node / Streamable HTTP | Tasks 1, 11 |
| Token math (3 tools resident) | Verified by Task 11 (`listTools` returns exactly 3) |

No gaps.

**Placeholder scan:** No TBD/TODO/"handle edge cases" — every code step is complete.

**Type consistency:** `RegistryOperation`, `SearchHit`, `AuthContext`, `HandlerDeps`, `ServerDeps`, `FetchLike`, `ProjectResult` used identically across tasks. Operation id format `"<service>.<operationId>"` consistent. `inputSchema` shape (params as top-level props + `body` nested) consistent between generator (Task 4) and handlers/tests (Tasks 6, 10).
