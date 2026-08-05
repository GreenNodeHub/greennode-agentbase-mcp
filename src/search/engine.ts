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
