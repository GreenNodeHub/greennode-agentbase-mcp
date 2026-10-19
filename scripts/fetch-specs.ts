import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPECS_DIR = join(HERE, "..", "specs");

// Prod spec URLs — the source of truth for the committed fixtures. Same host
// the server calls at runtime (src/config/env.ts BASE_URLS), so the operation
// set the model sees via search_tools matches what execute actually hits.
//
// Exception: tools (built-in browsers + code interpreters) is dev-only today —
// its prod base awaits go-live and serves nothing yet — so the spec comes
// from the dev host. Swap to the prod swagger URL when the service goes live.
const SPEC_URLS: Record<string, string> = {
  policy: "https://agentbase.api.vngcloud.vn/policy/swagger/doc.json",
  cr: "https://agentbase.api.vngcloud.vn/cr/swagger/doc.json",
  gateway: "https://agentbase.api.vngcloud.vn/gateway/swagger/doc.json",
  identity: "https://agentbase.api.vngcloud.vn/identity/api-docs",
  memory: "https://agentbase.api.vngcloud.vn/memory/v3/api-docs",
  runtime: "https://agentbase.api.vngcloud.vn/runtime/v3/api-docs",
  tools: "https://pub-iamapis.api-dev.vngcloud.tech/built-in-tools/swagger/doc.json",
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
