import { expect, test } from "bun:test";
import { initialsOf } from "./types";

// The initials of a name come from its words with a letter or a digit: a "·", a "—", a "&" or an emoji between them is
// no part of the name (W9: "東京オフィス · 物流チーム" gave "東·"). Two initials of a joining script (Arabic) stand apart.
test("initials take the first letter or digit of the first two words that have one", () => {
  const cases: [string, string][] = [
    ["東京オフィス · 物流チーム", "東物"],
    ["Ada — Renz", "AR"],
    ["Müller & Söhne", "MS"],
    ["🎉 Sommerfest", "S"],
    ["🎉", ""],
    ["A B", "AB"],
    ["Ada", "A"],
    ["ada.renz@example.org", "A"],
    ["(Ada) Renz", "AR"],
    ["4711 Kölnisch", "4K"],
    // two Arabic initials stand apart, each in its isolated form, not joined into one word
    ["محمد علي", "م\u200Cع"],
    ["علي", "ع"],
  ];
  for (const [name, initials] of cases) expect({ name, initials: initialsOf({ name }) }).toEqual({ name, initials });
});

test("given initials win over the name", () => {
  expect(initialsOf({ name: "东京 · 物流", initials: "TK" })).toBe("TK");
});
