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
