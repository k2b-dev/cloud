import { describe, expect, test } from "bun:test";
import { validateAccessLevelForResource } from "./access";

describe("validateAccessLevelForResource", () => {
  test("bases accept the full Cloud permission order", () => {
    for (const level of ["read", "write", "admin", "none"]) {
      expect(validateAccessLevelForResource("base", level), level).toBeNull();
    }
  });

  test("Grids Apps only accept read and none", () => {
    expect(validateAccessLevelForResource("customApp", "read")).toBeNull();
    expect(validateAccessLevelForResource("customApp", "none")).toBeNull();
    expect(validateAccessLevelForResource("customApp", "write")).toBe("Grids App grants only accept 'read' or 'none'.");
  });
});
