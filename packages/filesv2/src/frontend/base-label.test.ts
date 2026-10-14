import { describe, expect, test } from "bun:test";
import { baseLabel } from "./base-label";

describe("baseLabel", () => {
  const messages = { personal: "Persönlich" };
  test("group areas use the German group display name; the personal area stays Personal", () => {
    expect(baseLabel({ name: "buchhaltung", kind: "groups" }, messages, "de")).toBe("Buchhaltung");
    expect(baseLabel({ name: "buchhaltung", kind: "groups" }, { personal: "Personal" }, "en")).toBe("buchhaltung");
    expect(baseLabel({ name: "alice", kind: "users" }, messages, "de")).toBe("Persönlich");
  });
});
