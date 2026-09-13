import { expect, test } from "bun:test";
import { canonicalJson } from "./document-json";

test("canonical JSON v2 orders Unicode keys without locale or insertion-order ties", () => {
  const entries: Array<[string, unknown]> = [
    ["é", 1],
    ["é", 2],
    ["Z", 3],
    ["a", { ö: 4, A: 5 }],
  ];
  const first = canonicalJson(Object.fromEntries(entries), "de");
  const reversed = canonicalJson(Object.fromEntries([...entries].reverse()), "en");
  expect(first.json).toBe('{"Z":3,"a":{"A":5,"ö":4},"é":2,"é":1}');
  expect(first.sha256).toBe("13b4a387be695577144cff0431324b663ce4ea3860404a28f2c19efe4d48809f");
  expect(reversed).toEqual(first);
  expect(canonicalJson({ é: 1 }).sha256).not.toBe(canonicalJson({ é: 1 }).sha256);
});
