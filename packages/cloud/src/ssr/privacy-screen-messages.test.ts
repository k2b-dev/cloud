import { expect, test } from "bun:test";
import { PRIVACY_TIMER_CHOICES } from "../contracts/screen-preferences";
import { privacyScreenMessages, privacyTimerLabel, privacyTimerPhrase } from "./privacy-screen-messages";

test("keeps the English and German catalogs complete", () => {
  expect(privacyScreenMessages.check()).toEqual([]);
});

test("names the timer choices as the segmented row and the command menu show them", () => {
  const de = privacyScreenMessages.resolve(["de"]).t;
  const en = privacyScreenMessages.resolve(["en"]).t;
  expect(PRIVACY_TIMER_CHOICES.map((seconds) => privacyTimerLabel(de, seconds))).toEqual(["Aus", "30 s", "1 min", "2 min", "5 min"]);
  expect(PRIVACY_TIMER_CHOICES.map((seconds) => privacyTimerLabel(en, seconds))).toEqual(["Off", "30 s", "1 min", "2 min", "5 min"]);
  expect(de.commandTimerDescription({ value: privacyTimerPhrase(de, 120) })).toBe("Profileinstellungen › Am Bildschirm · jetzt: nach 2 min");
  expect(de.commandTimerDescription({ value: privacyTimerPhrase(de, 0) })).toBe("Profileinstellungen › Am Bildschirm · jetzt: aus");
});
