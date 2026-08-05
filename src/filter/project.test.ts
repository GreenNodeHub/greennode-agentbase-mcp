import { describe, it, expect } from "vitest";
import { projectAndCap } from "./project.js";

const data = {
  items: [
    { id: "a", name: "Alpha", status: "RUNNING", secret: "x" },
    { id: "b", name: "Beta", status: "STOPPED", secret: "y" },
  ],
};

describe("projectAndCap", () => {
  it("returns full JSON when no fields given", () => {
    const r = projectAndCap(data, undefined, 25_000);
    expect(r.truncated).toBe(false);
    expect(JSON.parse(r.text)).toEqual(data);
  });

  it("applies a JMESPath projection", () => {
    const r = projectAndCap(
      data,
      "items[].{id: id, name: name, status: status}",
      25_000,
    );
    const parsed = JSON.parse(r.text);
    expect(parsed).toEqual([
      { id: "a", name: "Alpha", status: "RUNNING" },
      { id: "b", name: "Beta", status: "STOPPED" },
    ]);
  });

  it("truncates oversized output and flags it", () => {
    const big = { blob: "z".repeat(1000) };
    const r = projectAndCap(big, undefined, 100);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("[truncated");
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThan(300);
  });

  it("reports a clear error for an invalid JMESPath expression", () => {
    const r = projectAndCap(data, "items[.broken", 25_000);
    expect(r.text).toContain("invalid fields expression");
  });
});
