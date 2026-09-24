import { describe, expect, test } from "bun:test";
import { baseLabel } from "./base-label";

describe("baseLabel", () => {
  const messages = { myFiles: "Meine Dateien" };
  test("group areas use the German group display name; the personal area stays My files", () => {
    expect(baseLabel({ name: "buchhaltung", kind: "groups" }, messages, "de")).toBe("Buchhaltung");
    expect(baseLabel({ name: "buchhaltung", kind: "groups" }, { myFiles: "My files" }, "en")).toBe("buchhaltung");
    expect(baseLabel({ name: "alice", kind: "users" }, messages, "de")).toBe("Meine Dateien");
  });
});
