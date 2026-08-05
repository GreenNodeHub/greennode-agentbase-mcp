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

  it("rejects when a required path parameter is missing, without calling fetch", async () => {
    const cap: any = { called: false };
    const fetchImpl = async (url: string, init?: any) => {
      cap.called = true;
      cap.url = url;
      cap.init = init;
      return {
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({}),
      };
    };
    await expect(
      callDownstream(
        { op: baseOp, args: { expand: "traces" }, baseUrl: "https://h/runtime", bearerToken: "TKN" },
        fetchImpl,
      ),
    ).rejects.toThrow(/id/);
    expect(cap.called).toBe(false);
  });
});
