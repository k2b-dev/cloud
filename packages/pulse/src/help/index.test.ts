import { expect, test } from "bun:test";
import { pulseHelp } from ".";

test("Pulse help keeps source, data model and operations topics in both locales", () => {
  expect(pulseHelp.documents.map((document) => document.id)).toEqual(["pulse-start", "pulse-data-model", "pulse-operate"]);
  expect(pulseHelp.documentsByLocale?.de?.map((document) => document.id)).toEqual(
    pulseHelp.documentsByLocale?.en?.map((document) => document.id),
  );
  for (const document of pulseHelp.documents) {
    expect(pulseHelp.getMarkdown(document.id, "en")).toBeDefined();
    expect(pulseHelp.getMarkdown(document.id, "de-CH")).toBeDefined();
    const german = pulseHelp.documentsByLocale?.de?.find((candidate) => candidate.id === document.id);
    expect(german?.icon).toBe(document.icon);
    expect(german?.order).toBe(document.order);
  }
  expect(pulseHelp.getMarkdown("pulse-start", "de-CH")).toContain("Quellen");
  expect(pulseHelp.getMarkdown("pulse-start", "fr")).toBe(pulseHelp.getMarkdown("pulse-start", "en"));
});
