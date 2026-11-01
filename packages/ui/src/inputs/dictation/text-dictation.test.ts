import { describe, expect, test } from "bun:test";
import {
  beginTextDictation,
  discardTextDictation,
  insertTextDictation,
  mapTextDictation,
  splitDictationSegments,
  type TextDictationState,
} from "./text-dictation";

const dictate = (value: string, mark: number, ...chunks: string[]) => {
  let state: TextDictationState = beginTextDictation(mark);
  let text = value;
  for (const chunk of chunks) ({ state, value: text } = insertTextDictation(state, text, chunk));
  return { state, text };
};

describe("text dictation", () => {
  test("appends at the mark and adds one space after earlier words", () => {
    const { state, text } = dictate("Schreib bitte:", 14, "Wir", " verschieben", " den Aufbau");
    expect(text).toBe("Schreib bitte: Wir verschieben den Aufbau");
    expect(state.ranges).toEqual([[14, 41]]);
    expect(state.mark).toBe(41);
  });

  test("drops the leading space at the start of a field or after a space", () => {
    expect(dictate("", 0, " Hallo", " Welt").text).toBe("Hallo Welt");
    expect(dictate("Mail an Jana ", 13, " Wir").text).toBe("Mail an Jana Wir");
  });

  test("lands between existing lines and leaves them alone", () => {
    const { text } = dictate("eins\n\ndrei", 5, "zwei");
    expect(text).toBe("eins\nzwei\ndrei");
  });

  test("typing elsewhere moves the mark and the ranges along", () => {
    const { state, text } = dictate("Anfang. Ende.", 7, " Mitte");
    // The person types at the very start while dictation writes on in the middle.
    const typed = `Neu: ${text}`;
    const mapped = mapTextDictation(state, text, typed);
    expect(mapped.ranges).toEqual([[12, 18]]);
    expect(mapped.mark).toBe(18);
    const next = insertTextDictation(mapped, typed, " weiter");
    expect(next.value).toBe("Neu: Anfang. Mitte weiter Ende.");
  });

  test("text typed right after the dictated words stays outside its range", () => {
    const { state, text } = dictate("A", 1, " b");
    const typed = `${text} c`;
    const mapped = mapTextDictation(state, text, typed);
    expect(mapped.ranges).toEqual([[1, 3]]);
    expect(discardTextDictation(mapped, typed).value).toBe("A c");
  });

  test("discard removes only dictated text, also across two sessions at one mark", () => {
    let { state, text } = dictate("Vorher.", 7, " Eins");
    state = { ...state, fresh: true };
    ({ state, value: text } = insertTextDictation(state, text, " zwei"));
    expect(text).toBe("Vorher. Eins zwei");
    expect(discardTextDictation(state, text)).toEqual({ value: "Vorher.", caret: 7 });
  });

  test("a range deleted by the person disappears", () => {
    const { state, text } = dictate("x", 1, " weg");
    const mapped = mapTextDictation(state, text, "x");
    expect(mapped.ranges).toEqual([]);
  });

  test("splits overlay segments at fresh words and the mark", () => {
    const parts = splitDictationSegments([{ text: "Hallo Welt heute" }], [[6, 10]], 10);
    expect(parts).toEqual([{ text: "Hallo " }, { text: "Welt", fresh: true }, { text: "", mark: true }, { text: " heute" }]);
    expect(splitDictationSegments([{ text: "ab" }], [], 2).at(-1)).toEqual({ text: "", mark: true });
  });
});

describe("text dictation before existing text", () => {
  test("keeps one space to the following word and writes on before it", () => {
    const { state, text } = dictate("existing", 0, "First", " words");
    expect(text).toBe("First words existing");
    expect(discardTextDictation(state, text).value).toBe("existing");
  });
});
