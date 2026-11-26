import { expect, test } from "bun:test";
import { addressKey, scanAddresses } from "./addresses";

test("addresses: bare, with a name, with a quoted name that has a comma, and with a name that has one", () => {
  expect(scanAddresses('"Berg, Anna" <anna@werkstatt.example>, jonas@werkstatt.example').found).toEqual([
    '"Berg, Anna" <anna@werkstatt.example>',
    "jonas@werkstatt.example",
  ]);
  // a comma before <…> with no address before it belongs to the name
  expect(scanAddresses("Berg, Anna <anna@werkstatt.example>; Mia Lindqvist <mia@lindqvist.example>").found).toEqual([
    "Berg, Anna <anna@werkstatt.example>",
    "Mia Lindqvist <mia@lindqvist.example>",
  ]);
  // a space ends a bare address, never a name
  expect(scanAddresses("a@werkstatt.example b@werkstatt.example\nAnna Berg <anna@werkstatt.example>").found).toEqual([
    "a@werkstatt.example",
    "b@werkstatt.example",
    "Anna Berg <anna@werkstatt.example>",
  ]);
  // an escaped quote stays inside the name
  expect(scanAddresses('"Anna \\"Ann\\" Berg" <anna@werkstatt.example>').found).toEqual(['"Anna \\"Ann\\" Berg" <anna@werkstatt.example>']);
});

test("addresses: what is no address stays with its own separators, and a name being typed is no address yet", () => {
  expect(scanAddresses("kein-at-zeichen; buero@werkstatt.example, noch eins")).toEqual({
    found: ["buero@werkstatt.example"],
    rest: "kein-at-zeichen; noch eins",
  });
  expect(scanAddresses("Anna Berg,")).toEqual({ found: [], rest: "Anna Berg" });
  // while typing, the entry still open stays as it is typed, with its comma and its space
  expect(scanAddresses("jonas@werkstatt.example, Mia Lindqvist,", { final: false })).toEqual({
    found: ["jonas@werkstatt.example"],
    rest: "Mia Lindqvist,",
  });
  expect(scanAddresses("jonas@werkstatt.example; kaputt; Mia ", { final: false })).toEqual({
    found: ["jonas@werkstatt.example"],
    rest: "kaputt; Mia ",
  });
  expect(scanAddresses("anna@ ; @werkstatt.example ; anna@werkstatt").found).toEqual([]);
});

test("addresses: the key of an address is its address in small letters, whatever its name", () => {
  expect(addressKey("Anna Berg <Anna@Werkstatt.example>")).toBe(addressKey("anna@werkstatt.example"));
});

test("addresses: a megabyte of pasted text is read in one pass", () => {
  const one = "Anna Berg <anna.berg@werkstatt.example>, ";
  const text = one.repeat(Math.ceil(1_000_000 / one.length));
  const started = performance.now();
  const { found } = scanAddresses(text);
  expect(found.length).toBe(Math.ceil(1_000_000 / one.length));
  // linear: far below the second a quadratic reading took for a tenth of this
  expect(performance.now() - started).toBeLessThan(500);
});

test("addresses: a semicolon and a new line always end an entry; only a comma may belong to a name", () => {
  expect(scanAddresses("Kein Name\nAnna Berg <anna@werkstatt.example>")).toEqual({
    found: ["Anna Berg <anna@werkstatt.example>"],
    rest: "Kein Name",
  });
  expect(scanAddresses("Kein Name; Anna Berg <anna@werkstatt.example>")).toEqual({
    found: ["Anna Berg <anna@werkstatt.example>"],
    rest: "Kein Name",
  });
});

test("addresses: while typing, only entries a separator closed are taken; the last one waits for Enter, a paste or leaving", () => {
  expect(scanAddresses("Mia Lindqvist, mia@lindqvist.e", { final: false })).toEqual({ found: [], rest: "Mia Lindqvist, mia@lindqvist.e" });
  expect(scanAddresses("jonas@werkstatt.example, mia@lindqvist.e", { final: false })).toEqual({
    found: ["jonas@werkstatt.example"],
    rest: "mia@lindqvist.e",
  });
  expect(scanAddresses("Mia Lindqvist <mia@lindqvist.example>").found).toEqual(["Mia Lindqvist <mia@lindqvist.example>"]);
});

test("addresses: Outlook's quoted address as name; an unclosed quote or bracket holds the rest; no dot at the end of a domain", () => {
  expect(scanAddresses("'anna@werkstatt.example' <anna@werkstatt.example>").found).toEqual([
    "'anna@werkstatt.example' <anna@werkstatt.example>",
  ]);
  expect(scanAddresses('jonas@werkstatt.example; "Anna <anna@werkstatt.example>, mia@lindqvist.example')).toEqual({
    found: ["jonas@werkstatt.example"],
    rest: '"Anna <anna@werkstatt.example>, mia@lindqvist.example',
  });
  expect(scanAddresses("jonas@werkstatt.example; <anna@werkstatt.example").found).toEqual(["jonas@werkstatt.example"]);
  expect(scanAddresses("anna@werkstatt.example.").found).toEqual([]);
  expect(scanAddresses("anna@werkstatt..example").found).toEqual([]);
});
