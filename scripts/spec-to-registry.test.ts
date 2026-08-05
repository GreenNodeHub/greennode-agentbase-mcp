import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("generated registry artifact", () => {
  it("contains 109 operations across 6 services", () => {
    const path = join(process.cwd(), "registry.generated.json");
    const reg = JSON.parse(readFileSync(path, "utf8"));
    expect(reg.operations.length).toBe(109);
    const services = new Set(reg.operations.map((o: any) => o.service));
    expect([...services].sort()).toEqual(
      ["cr", "gateway", "identity", "memory", "policy", "runtime"].sort(),
    );
  });
});
