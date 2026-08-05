import { describe, it, expect } from "vitest";
import { authenticate, authenticateFromEnv, AuthError } from "./inbound.js";

describe("authenticate", () => {
  it("returns the bearer token when present", () => {
    const ctx = authenticate({ authorization: "Bearer ABC" });
    expect(ctx.bearerToken).toBe("ABC");
  });

  it("rejects a missing bearer token with 401 'missing upstream token'", () => {
    try {
      authenticate({});
    } catch (e) {
      expect((e as AuthError).status).toBe(401);
      expect((e as AuthError).message).toMatch(/missing upstream token/i);
    }
  });
});

describe("authenticateFromEnv", () => {
  it("returns the token from the named env var", () => {
    const ctx = authenticateFromEnv({ GREENNODE_MCP_TOKEN: "ABC" }, "GREENNODE_MCP_TOKEN");
    expect(ctx.bearerToken).toBe("ABC");
  });

  it("honors a custom TOKEN_ENV name", () => {
    const ctx = authenticateFromEnv({ MY_TOKEN: "XYZ" }, "MY_TOKEN");
    expect(ctx.bearerToken).toBe("XYZ");
  });

  it("throws 401 'missing upstream token' when the var is missing", () => {
    try {
      authenticateFromEnv({}, "GREENNODE_MCP_TOKEN");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as AuthError).status).toBe(401);
      expect((e as AuthError).message).toMatch(/missing upstream token/i);
    }
  });

  it("throws 401 when the var is empty", () => {
    try {
      authenticateFromEnv({ GREENNODE_MCP_TOKEN: "" }, "GREENNODE_MCP_TOKEN");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as AuthError).status).toBe(401);
    }
  });
});
