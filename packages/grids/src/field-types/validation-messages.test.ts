import { expect, test } from "bun:test";
import { validateDefaultValue } from "../service/field-validation";
import { objectListScalarHandlers, validateObjectList } from "./object-list";

test("scalar validators localize at the rule owner without leaking locale between calls", () => {
  const cases = [
    { type: "text", value: "x", config: { minLength: 2 }, error: "Bitte mindestens 2 Zeichen eingeben." },
    { type: "longtext", value: "long", config: { maxLength: 2 }, error: "Bitte auf höchstens 2 Zeichen kürzen." },
    { type: "number", value: "1.234", config: { decimalPlaces: 2 }, error: "Höchstens 2 Nachkommastellen sind erlaubt." },
    { type: "boolean", value: "invalid", config: {}, error: "Bitte Ja oder Nein auswählen." },
    { type: "date", value: "invalid", config: {}, error: "Bitte ein gültiges Datum eingeben." },
    { type: "select", value: ["missing"], config: { options: [] }, error: "Die Option „missing“ ist nicht verfügbar." },
    { type: "percent", value: 101, config: {}, error: "Bitte einen Wert zwischen 0 und 100 eingeben." },
    { type: "duration", value: -1, config: {}, error: "Bitte eine endliche Dauer ab null Sekunden eingeben." },
  ] as const;
  for (const example of cases) {
    const handler = objectListScalarHandlers[example.type];
    const english = handler.validate(example.value, example.config, false);
    expect(handler.validate(example.value, example.config, false, { locale: "de-CH" })).toEqual({ ok: false, error: example.error });
    expect(handler.validate(example.value, example.config, false)).toEqual(english);
    expect(handler.validate(example.value, example.config, false, { locale: "fr" })).toEqual(english);
  }
});

test("object lists retain row/column context and localize nested scalar and structural failures", () => {
  const config = { fields: [{ id: "Amount", name: "Betrag", type: "number", required: true, config: { decimalPlaces: 2 } }] };
  const context = { locale: "de" };
  expect(validateObjectList([{ Amount: "1.00" }, { Amount: "1.234" }], config, false, { context })).toEqual({
    ok: false,
    error: "Zeile 2, Betrag: Höchstens 2 Nachkommastellen sind erlaubt.",
  });
  expect(validateObjectList([{}], config, false, { context })).toEqual({ ok: false, error: "Zeile 1, Betrag: Bitte einen Wert eingeben." });
  expect(validateObjectList([], { ...config, minItems: 1 }, false, { context })).toEqual({
    ok: false,
    error: "Bitte mindestens eine Zeile hinzufügen.",
  });
  expect(validateObjectList([{ Other1: "x" }], config, false, { context })).toEqual({
    ok: false,
    error: "Zeile 1: Die Spalte „Other1“ ist nicht vorhanden.",
  });
  expect(validateObjectList([{ Amount: "1.00" }], config, false, { context })).toEqual({ ok: true, value: [{ Amount: "1.00" }] });
  const result = validateDefaultValue("object_list", config, [{ Amount: "wrong" }], "de-CH");
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain("Zeile 1, Betrag: Bitte eine gültige, endliche Zahl eingeben.");
});
