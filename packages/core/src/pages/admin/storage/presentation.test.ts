import { expect, test } from "bun:test";
import { storageEndpointHost } from "./presentation";

test("the list line shows the endpoint's host, parsed rather than matched", () => {
  expect(storageEndpointHost("https://fsn1.objekt-anbieter.example")).toBe("fsn1.objekt-anbieter.example");
  expect(storageEndpointHost("http://127.0.0.1:3900/")).toBe("127.0.0.1:3900");
  expect(storageEndpointHost("https://s3.example.org/path?query#fragment")).toBe("s3.example.org");
  expect(storageEndpointHost(null)).toBe("");
  expect(storageEndpointHost("")).toBe("");
});

test("an invalid endpoint shows as typed, bounded, in linear time", () => {
  expect(storageEndpointHost("not a url")).toBe("not a url");
  // The input that made the former regular expressions backtrack polynomially.
  const hostile = `http://${"/".repeat(50_000)}x`;
  const started = performance.now();
  const shown = storageEndpointHost(hostile);
  expect(performance.now() - started).toBeLessThan(250);
  expect(shown.length).toBeLessThanOrEqual(80);
});
