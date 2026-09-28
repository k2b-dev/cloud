import { describe, expect, test } from "bun:test";
import { buildSectionPatch } from "./cli";

const none = { enabled: false, disabled: false };

describe("cld venue sections update", () => {
  test("sends only the fields that were passed", () => {
    expect(buildSectionPatch({ ...none, title: "Winter hours" })).toEqual({ title: "Winter hours" });
    expect(buildSectionPatch({ ...none, content: { text: "Closed on Friday" } })).toEqual({ content: { text: "Closed on Friday" } });
    expect(buildSectionPatch({ ...none, position: 0 })).toEqual({ position: 0 });
  });

  test("changes visibility only with --enabled or --disabled", () => {
    expect(buildSectionPatch({ ...none, title: "Draft" })).not.toHaveProperty("enabled");
    expect(buildSectionPatch({ enabled: false, disabled: true })).toEqual({ enabled: false });
    expect(buildSectionPatch({ enabled: true, disabled: false })).toEqual({ enabled: true });
    expect(() => buildSectionPatch({ enabled: true, disabled: true })).toThrow("Pass only one of --enabled or --disabled.");
  });

  test("refuses an update without changes", () => {
    expect(() => buildSectionPatch(none)).toThrow("Nothing to update.");
  });
});
