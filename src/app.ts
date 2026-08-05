import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { EnvConfig } from "./config/env.js";
import type { RegistryStore } from "./registry/loader.js";
import type { SearchEngine } from "./search/engine.js";
import type { FetchLike } from "./http/downstream.js";
import { authenticate, AuthError, type AuthContext } from "./auth/inbound.js";
import { createMcpServer } from "./server.js";

export interface AppDeps {
  registry: RegistryStore;
  engine: SearchEngine;
  config: EnvConfig;
  fetchImpl?: FetchLike;
}

// Gateway-only. `buildServer` is kept as a thin seam so the transport wiring
// (HTTP per-request + stdio once-per-process) shares one server-construction
// call site.
export function buildServer(deps: AppDeps, auth: AuthContext) {
  return createMcpServer(deps, auth);
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  const healthHandler: express.RequestHandler = (_req, res) =>
    res.json({ ok: true });
  app.get("/healthz", healthHandler);
  app.get("/health", healthHandler);

  app.post("/mcp", async (req, res) => {
    let auth;
    try {
      auth = authenticate(req.headers as any);
    } catch (e) {
      const err = e as AuthError;
      res.status(err.status ?? 401).json({ error: err.message });
      return;
    }

    // Stateless: one server + transport per request.
    const server = buildServer(deps, auth);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
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
