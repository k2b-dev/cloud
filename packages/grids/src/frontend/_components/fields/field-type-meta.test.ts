import { describe, expect, test } from "bun:test";
import { FIELD_CHOICE_GROUPS, fieldChoiceGroupsFor, fieldTypeGroups, fieldTypeLabel } from "./field-type-meta";

describe("field choice groups", () => {
  test("uses the complete field taxonomy", () => {
    expect(FIELD_CHOICE_GROUPS.map((group) => group.label)).toEqual(["Basic", "Relations", "Computed", "System", "Files"]);
  });

  test("supports overlapping relation and computed fields", () => {
    expect(fieldTypeGroups("lookup")).toEqual(["relations", "computed"]);
    expect(fieldTypeGroups("file")).toEqual(["files"]);
    expect(fieldTypeGroups("created_at")).toEqual(["system"]);
  });

  test("only exposes groups represented by the current options", () => {
    expect(fieldChoiceGroupsFor([{ type: "text" }, { type: "lookup" }], ["system"]).map((group) => group.label)).toEqual([
      "Basic",
      "Relations",
      "Computed",
      "System",
    ]);
  });

  test("localizes group and type labels with language fallback", () => {
    expect(fieldChoiceGroupsFor([{ type: "text" }, { type: "lookup" }], ["system"], "de").map((group) => group.label)).toEqual([
      "Grundlegend",
      "Relationen",
      "Berechnet",
      "System",
    ]);
    expect(fieldTypeLabel("longtext", "de-CH")).toBe("Langtext");
    expect(fieldTypeLabel("longtext", "en")).toBe("Long text");
  });
});
