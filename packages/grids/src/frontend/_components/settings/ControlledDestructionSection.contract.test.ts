import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./ControlledDestructionSection.tsx", import.meta.url), "utf8");
const messages = readFileSync(new URL("./messages.ts", import.meta.url), "utf8");

describe("Controlled destruction settings contract", () => {
  test("uses one owner-local overview and the typed API for every action", () => {
    expect(source).toContain("query.create");
    expect(source).toContain('["controlled-destruction"]');
    expect(source).toContain("fileIds: current.items.map");
    expect(source).toContain("confirmation: props.baseName");
    expect(source).toContain("confirmationPhrase: props.baseName");
    expect(source).toContain("setInterval");
    expect(source).toContain("cancel.$post");
  });

  test("states the irreversible and bounded File-only consequences", () => {
    for (const text of [
      "Controlled File destruction",
      "Records and evidence artifacts are never included.",
      "at most 100",
      "Files in next run",
      "Every File is rechecked before removal",
      "already destroyed cannot be recovered",
      "Loading destruction preview",
      "Controlled destruction is unavailable",
      "No controlled destruction runs yet.",
      "Cancel remaining",
    ])
      expect(messages).toContain(text);
    expect(source).toContain("useGridsSettingsMessages(locale)");
    expect(source).toContain("<StatGrid");
    expect(source).toContain("<StatCell");
  });
});
