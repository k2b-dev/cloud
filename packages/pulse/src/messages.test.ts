import { expect, test } from "bun:test";
import { pulseMessages } from "./messages";

test("Pulse messages contain matching locale contracts", () => {
  expect(pulseMessages.check()).toEqual([]);
});

test("Pulse explains the hard cut in both locales", () => {
  const en = pulseMessages.resolve(["en"]).t;
  const de = pulseMessages.resolve(["de"]).t;
  expect(en.comingBackTitle).toBe("Dashboards and questions are coming back");
  expect(en.comingBackBody).toContain("Earlier dashboards and saved queries were removed with this update.");
  expect(de.comingBackTitle).toBe("Dashboards und Fragen kommen zurück");
  expect(de.comingBackBody).toContain("Pulse sammelt alle Werte deiner Quellen weiter.");
});
