import { expect, test } from "bun:test";
import { CodeActivityReadModelSchema, CodeRunReadModelSchema } from "@k2b/cloud/contracts";
import { effectTarget, presentEffect } from "./effects";
import { codeActivityReadModelFixture, codeRunReadModelFixture } from "./fixtures";
import type { ReadModelNames } from "./present";

const target = { type: "fictional.task", id: "secret-id" };
const evidence = {
  forms: {
    de: { text: "{target} angelegt", kind: "Aufgabe", targetType: target.type },
    en: { text: "Created {target}", kind: "task", targetType: target.type },
  },
  refs: [target],
};
const names = (readable: boolean): ReadModelNames => ({
  target: () => ({ name: "Private delivery", readable, href: "/fictional/task" }),
  operation: () => ({ title: "Aufgabe anlegen", app: "Fictional", icon: "ti ti-list" }),
  event: () => "Event",
});
test("result forms use evidence and current reader names, links and app tiles in de/en", () => {
  const input = { operation: "fictional.create", target: null, evidence };
  expect(presentEffect(input, names(true), "de")).toEqual({
    text: "Aufgabe „Private delivery“ angelegt",
    app: "Fictional",
    icon: "ti ti-list",
    href: "/fictional/task",
    state: "succeeded",
  });
  expect(presentEffect(input, names(true), "en").text).toBe("Created task “Private delivery”");
  const hidden = presentEffect(input, names(false), "de");
  expect(hidden.text).toBe("Aufgabe angelegt");
  expect(JSON.stringify(hidden)).not.toMatch(/Private delivery|secret-id|fictional\/task/);
});
test("unknown, ambiguous, and incomplete evidence use a counted Action, never invented results", () => {
  for (const value of [null, {}, { ...evidence, refs: [target, { ...target, id: "other" }] }])
    expect(presentEffect({ operation: "fictional.create", target: null, evidence: value, count: 3 }, names(true), "de").text).toBe(
      "Aufgabe anlegen · 3 Mal",
    );
  expect(effectTarget(evidence, "de", { type: "fictional.folder", id: "folder" })?.ref).toEqual(target);
  expect(presentEffect({ operation: "x", target: null, evidence: null }, names(true), "en").text).toBe("Aufgabe anlegen · 1 time");
});
test("all consumer fixtures use the same bounded de/en contracts", () => {
  for (const locale of ["de", "en"] as const) {
    expect(CodeActivityReadModelSchema.safeParse(codeActivityReadModelFixture(locale)).success).toBe(true);
    expect(CodeRunReadModelSchema.safeParse(codeRunReadModelFixture(locale)).success).toBe(true);
  }
});
