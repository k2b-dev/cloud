import { expect, test } from "bun:test";
import { z } from "zod";
import { CodeAutomationTitleSchema } from "./code-version";

// A capability's registered schema is JSON Schema, read back with `z.fromJSONSchema`, which builds its patterns without
// the `u` flag. A `\p{…}` class there matches literal letters and rejects ordinary titles (#3426).
const registered = z.fromJSONSchema(z.toJSONSchema(z.object({ title: CodeAutomationTitleSchema }), { io: "output" }));

test("ordinary titles pass both the source schema and the registered one", () => {
  for (const title of ["Lieferavise abgleichen", "Preisliste von Stoffe Nord holen", "Wochenbericht · KW 45", "Café-Zähler {pf}"]) {
    expect(CodeAutomationTitleSchema.safeParse(title).success).toBe(true);
    expect(registered.safeParse({ title }).success).toBe(true);
  }
});

test("markup, control, line and format characters stay out of a title", () => {
  for (const title of ["a<b", "a>b", "a\u0007b", "a\u0085b", "a b", "a b"]) {
    expect(CodeAutomationTitleSchema.safeParse(title).success).toBe(false);
    expect(registered.safeParse({ title }).success).toBe(false);
  }
  // Format characters are checked where the title is made; the registered schema cannot name them without `u`.
  for (const title of ["a​b", "a‮b", "a﻿b"]) expect(CodeAutomationTitleSchema.safeParse(title).success).toBe(false);
});
