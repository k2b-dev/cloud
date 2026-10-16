import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isNotebookActivityAction, NOTEBOOK_ACTIVITY_ACTIONS } from "../lib/activity-actions";
import { describeNoteActivity, describeOverviewActivity } from "./activity-messages";

const locales = ["de", "en"] as const;
test("every activity written by a service has translated named, self and overview labels", () => {
  const serviceDir = fileURLToPath(new URL("../service/", import.meta.url));
  const written = new Set<string>();
  for (const file of new Bun.Glob("**/*.ts").scanSync({ cwd: serviceDir })) {
    if (/\.(test|spec)\.ts$/.test(file)) continue;
    const source = readFileSync(`${serviceDir}/${file}`, "utf8");
    for (const match of source.matchAll(/action:\s*"([^"]+)"/g)) {
      const action = match[1]!;
      // These two queue dispositions are not stored notebook activity.
      if (file === "yjs-snapshot-worker.ts" && (action === "retry" || action === "dead_letter")) continue;
      expect(isNotebookActivityAction(action), `${file}: ${action}`).toBe(true);
      written.add(action);
    }
  }
  expect([...written].sort()).toEqual([...NOTEBOOK_ACTIVITY_ACTIONS].sort());
  for (const action of NOTEBOOK_ACTIVITY_ACTIONS) {
    for (const locale of locales) {
      for (const self of [false, true]) {
        const label = describeNoteActivity(action, { self, locale });
        expect(label.trim().length).toBeGreaterThan(0);
        expect(label).not.toBe(action);
        expect(label).not.toContain(action.replaceAll(".", " "));
      }
      const label = describeOverviewActivity(action, { locale, target: "Plan", notebook: "Team" });
      expect(label.trim().length).toBeGreaterThan(0);
      expect(label).not.toBe(action);
    }
  }
});

test("unknown actions use localized neutral fallbacks without leaking keys", () => {
  for (const locale of locales) {
    for (const self of [false, true]) {
      const label = describeNoteActivity("note.moved", { self, locale });
      expect(label).toBe(locale === "en" ? "changed the note" : self ? "hast die Notiz geändert" : "hat die Notiz geändert");
      expect(label).not.toContain("note.moved");
      expect(label).not.toContain("note moved");
    }
    const label = describeOverviewActivity("note.moved", { locale, target: "Plan", notebook: "Team" });
    expect(label).toBe(locale === "en" ? "Changed a note in Team" : "Eine Notiz in Team geändert");
    expect(label).not.toContain("note.moved");
    expect(label).not.toContain("note moved");
  }
});
