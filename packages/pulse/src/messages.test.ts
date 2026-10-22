import { expect, test } from "bun:test";
import { pulseMessages } from "./messages";

test("Pulse messages contain matching locale contracts", () => {
  expect(pulseMessages.check()).toEqual([]);
});

test("Pulse distinguishes available SQL from planned dashboards in both locales", () => {
  const en = pulseMessages.resolve(["en"]).t;
  const de = pulseMessages.resolve(["de"]).t;
  expect(en.comingBackTitle).toBe("Dashboards are coming back");
  expect(en.comingBackBody).toContain("You can already query Pulse in SQL.");
  expect(en.comingBackBody).toContain("Earlier dashboards and saved queries were removed with this update.");
  expect(de.comingBackTitle).toBe("Dashboards kommen zurück");
  expect(de.comingBackBody).toContain("Du kannst Pulse schon mit SQL abfragen.");
  expect(de.comingBackBody).toContain("Pulse sammelt alle Werte deiner Quellen weiter.");
});
