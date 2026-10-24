import { describe, expect, test } from "bun:test";
import { Text } from "@codemirror/state";
import * as Y from "yjs";
import { applyToYText, changesBetween, rebaseOnto } from "./lazy-collab";

const apply = (base: string, changes: ReturnType<typeof changesBetween>) => changes.apply(Text.of(base.split("\n"))).toString();

describe("carrying the first edits onto the live note", () => {
  test("the edits between two texts rebuild the second from the first", () => {
    for (const [from, to] of [
      ["", "Hello"],
      ["Hello", ""],
      ["# Plan\n\nOne\nTwo", "# Plan\n\nOne and a half\nTwo"],
      ["abc", "xabcx"],
      ["Wochenplan für das Team", "Wochenplan für alle im Team!"],
      ["a\n".repeat(5000), `${"a\n".repeat(2500)}b\n${"a\n".repeat(2500)}`],
    ] as const)
      expect(apply(from, changesBetween(from, to))).toBe(to);
  });

  test("a note nobody else changed keeps exactly what the person typed", () => {
    expect(rebaseOnto("# Plan\n\nOne", "# Plan\n\nOne, two", "# Plan\n\nOne").text).toBe("# Plan\n\nOne, two");
  });

  test("text another editor added meanwhile stays, and the person's edit lands where they made it", () => {
    const base = "# Plan\n\nFirst line\n\nLast line";
    const edited = "# Plan\n\nFirst line with my words\n\nLast line";
    const live = "# Plan by the team\n\nFirst line\n\nLast line, signed";
    expect(rebaseOnto(base, edited, live).text).toBe("# Plan by the team\n\nFirst line with my words\n\nLast line, signed");
  });

  test("both inserting at one place keeps both, the live text first", () => {
    expect(rebaseOnto("ab", "aXb", "aYb").text).toBe("aYXb");
  });

  test("the rebased edits write to Yjs as one step and give the same text as the editor", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("codemirror");
    const live = "# Plan by the team\n\nFirst line\n\nLast line";
    ytext.insert(0, live);
    const steps: unknown[] = [];
    doc.on("afterTransaction", (transaction) => steps.push(transaction.origin));
    const origin = Symbol("first edit");
    const { changes, text } = rebaseOnto("# Plan\n\nFirst line\n\nLast line", "# Plan\n\nFirst line, edited\n\nLast line, too", live);
    applyToYText(ytext, changes, origin);
    expect(ytext.toString()).toBe(text);
    expect(text).toBe("# Plan by the team\n\nFirst line, edited\n\nLast line, too");
    expect(steps).toEqual([origin]);
  });
});
