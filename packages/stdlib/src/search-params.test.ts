import { describe, it, expect } from "bun:test";
import { searchParams, onChange } from "./search-params";

// ==========================
// deserialize
// ==========================

describe("searchParams.deserialize", () => {
  it("parses numbers", () => {
    const result = searchParams.deserialize(new URLSearchParams("page=2"));
    expect(result.page).toBe(2);
  });

  it("parses booleans", () => {
    const trueResult = searchParams.deserialize(new URLSearchParams("active=true"));
    expect(trueResult.active).toBe(true);

    const falseResult = searchParams.deserialize(new URLSearchParams("active=false"));
    expect(falseResult.active).toBe(false);
  });

  it("parses strings", () => {
    const result = searchParams.deserialize(new URLSearchParams("name=John"));
    expect(result.name).toBe("John");
  });

  it("parses JSON objects", () => {
    const result = searchParams.deserialize(new URLSearchParams('filter={"status":"open"}'));
    expect(result.filter).toEqual({ status: "open" });
  });

  it("falls back to string for invalid JSON", () => {
    const result = searchParams.deserialize(new URLSearchParams("x={broken"));
    expect(result.x).toBe("{broken");
  });

  it("returns empty object for empty params", () => {
    const result = searchParams.deserialize(new URLSearchParams(""));
    expect(result).toEqual({});
  });

  it("does not coerce empty string value to 0", () => {
    const result = searchParams.deserialize(new URLSearchParams("q="));
    // Empty string should stay as empty string due to value !== "" check
    expect(result.q).toBe("");
  });

  it("does not coerce whitespace-only strings to 0", () => {
    const result = searchParams.deserialize(new URLSearchParams("q=  "));
    expect(result.q).toBe("  ");
  });

  // Regression: __proto__ and friends must NOT pollute the prototype.
  it("ignores __proto__, constructor, prototype keys (no prototype pollution)", () => {
    const result = searchParams.deserialize(
      new URLSearchParams('__proto__={"isAdmin":true}&constructor=evil&prototype=x'),
    );
    // Forbidden keys never set on the result.
    expect((result as any).__proto__).not.toEqual({ isAdmin: true });
    expect((result as any).constructor).not.toBe("evil");
    // No prototype pollution: a fresh object should not inherit isAdmin.
    const fresh: any = {};
    expect(fresh.isAdmin).toBeUndefined();
  });
});

// ==========================
// serialize
// ==========================

describe("searchParams.serialize", () => {
  it("serializes primitives", () => {
    const result = searchParams.serialize({ page: 2, active: true }, new URLSearchParams());
    expect(result).toContain("page=2");
    expect(result).toContain("active=true");
  });

  it("removes undefined/null/false/empty string values", () => {
    const base = new URLSearchParams("page=1&name=John&active=true&q=hello");
    const result = searchParams.serialize(
      { page: undefined, name: null, active: false, q: "" } as any,
      base,
    );
    expect(result).not.toContain("page=");
    expect(result).not.toContain("name=");
    expect(result).not.toContain("active=");
    expect(result).not.toContain("q=");
  });

  it("serializes objects as JSON", () => {
    const result = searchParams.serialize(
      { filter: { status: "open" } },
      new URLSearchParams(),
    );
    // URLSearchParams encodes the JSON
    const parsed = new URLSearchParams(result);
    expect(JSON.parse(parsed.get("filter")!)).toEqual({ status: "open" });
  });

  it("merges with existing params", () => {
    const result = searchParams.serialize({ page: 2 }, new URLSearchParams("name=John"));
    expect(result).toContain("name=John");
    expect(result).toContain("page=2");
  });

  it("overrides existing params with same key", () => {
    const result = searchParams.serialize({ page: 3 }, new URLSearchParams("page=1"));
    const parsed = new URLSearchParams(result);
    expect(parsed.get("page")).toBe("3");
  });
});

// ==========================
// onChange
// ==========================

describe("searchParams.onChange", () => {
  it("returns a cleanup function", () => {
    const cleanup = onChange(() => {});
    expect(typeof cleanup).toBe("function");
    cleanup();
  });
});
