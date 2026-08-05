# specs/

Committed swagger/OpenAPI fixtures — **generated, do not hand-edit**.

- Refresh from prod: `npm run fetch-specs`
- Rebuild the registry: `npm run generate-registry`

Sources: policy/cr/gateway = Swagger 2.0; identity/memory/runtime = OpenAPI 3.1. Specs are fetched from the same prod host the server calls at runtime (`agentbase.api.vngcloud.vn`), so the operation set the model sees via `search_tools` matches what `execute` actually hits.
