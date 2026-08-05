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
