import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "./config/env.js";
import { RegistryStore } from "./registry/loader.js";
import { Bm25SearchEngine } from "./search/engine.js";
import { createApp, buildServer } from "./app.js";
import { authenticateFromEnv } from "./auth/inbound.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const config = loadEnvConfig(process.env);
const registry = RegistryStore.fromFile(
  join(HERE, "..", "registry.generated.json"),
);
const engine = new Bm25SearchEngine(registry.all(), config.searchLimitDefault);

if (config.transport === "http") {
  const app = createApp({ registry, engine, config });
  app.listen(config.port, () => {
    console.error(
      `greennode-agentbase-mcp listening on :${config.port} (transport=http)`,
    );
  });
} else {
  // stdio: one long-lived server for the process lifetime. All diagnostics
  // go to stderr — stdout is the JSON-RPC protocol.
  let auth;
  try {
    auth = authenticateFromEnv(process.env, config.tokenEnv);
  } catch (e) {
    console.error(`startup failed: ${(e as Error).message}`);
    process.exit(1);
  }

  const server = buildServer({ registry, engine, config }, auth);
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    server.close();
  };
  server.connect(transport).catch((e) => {
    console.error(`server connect failed: ${(e as Error).message}`);
    process.exit(1);
  });
  console.error(
    `greennode-agentbase-mcp stdio`,
  );
}
