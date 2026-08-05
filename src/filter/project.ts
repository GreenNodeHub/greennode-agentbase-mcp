import jmespath from "jmespath";

export interface ProjectResult {
  text: string;
  truncated: boolean;
}

export function projectAndCap(
  data: unknown,
  fields: string | undefined,
  maxBytes: number,
): ProjectResult {
  let value: unknown = data;
  if (fields) {
    try {
      value = jmespath.search(data, fields);
    } catch (e) {
      return {
        text: `invalid fields expression: ${(e as Error).message}`,
        truncated: false,
      };
    }
  }

  const json = JSON.stringify(value ?? null);
  if (Buffer.byteLength(json, "utf8") <= maxBytes) {
    return { text: json, truncated: false };
  }

  const notice = " …[truncated — narrow with fields/pagination]";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(notice, "utf8"));
  const sliced = Buffer.from(json, "utf8").subarray(0, budget).toString("utf8");
  return { text: sliced + notice, truncated: true };
}
