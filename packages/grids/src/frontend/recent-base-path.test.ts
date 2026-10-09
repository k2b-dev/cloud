import { describe, expect, test } from "bun:test";
import { recentBasePath } from "./recent-base-path";

const cookie = (path: string) => `settings-app-grids=${encodeURIComponent(JSON.stringify({ lastPath: path }))}`;

describe("recentBasePath", () => {
  test("accepts the public base ID", () => {
    expect(recentBasePath(cookie("/app/grids/BASE01/table/TABLE1?record=REC001"), [{ shortId: "BASE01" }])).toBe(
      "/app/grids/BASE01/table/TABLE1?record=REC001",
    );
  });

  test("rejects an internal base UUID", () => {
    const internalBase = { shortId: "BASE01", id: "11111111-1111-4111-8111-111111111111" };
    expect(recentBasePath(cookie("/app/grids/11111111-1111-4111-8111-111111111111"), [internalBase])).toBeNull();
  });

  test("stays below Grids when dot segments in the cookie would resolve to another host", () => {
    expect(recentBasePath(cookie("/app/grids/../..//evil.example/BASE01"), [{ shortId: "BASE01" }])).toBeNull();
  });
});
