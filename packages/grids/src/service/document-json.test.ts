import { expect, test } from "bun:test";
import { canonicalJson } from "./document-json";

test("canonical JSON v2 orders Unicode keys without locale or insertion-order ties", () => {
  const entries: Array<[string, unknown]> = [
    ["é", 1],
    ["é", 2],
    ["Z", 3],
    ["a", { ö: 4, A: 5 }],
  ];
  const first = canonicalJson(Object.fromEntries(entries), "de", 2);
  const reversed = canonicalJson(Object.fromEntries([...entries].reverse()), "en", 2);
  expect(first.json).toBe('{"Z":3,"a":{"A":5,"ö":4},"é":2,"é":1}');
  expect(reversed).toEqual(first);
  expect(canonicalJson({ é: 1 }, undefined, 2).sha256).not.toBe(canonicalJson({ é: 1 }, undefined, 2).sha256);
});

test("canonical JSON v1 retains the historical comparator for stored digests", () => {
  const input = { Z: 1, a: 2, ö: 3 };
  const historical = JSON.stringify(Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right))));
  expect(canonicalJson(input, undefined, 1).json).toBe(historical);
  expect(canonicalJson(input).json).toBe(historical);
});
