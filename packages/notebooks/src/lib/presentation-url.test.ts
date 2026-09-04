import { expect, test } from "bun:test";
import { inheritPresentationMode, requestedPresentationMode, withPresentationMode } from "./presentation-url";

test("mode URLs preserve navigator filters and heading anchors", () => {
  expect(withPresentationMode("/app/notebooks/book01/notes/note01?view=tag&tag=wiki#intro", "book")).toBe(
    "/app/notebooks/book01/notes/note01?view=tag&tag=wiki&mode=book#intro",
  );
  expect(withPresentationMode("/app/notebooks/book01/notes/note01?mode=versions", "write")).toBe(
    "/app/notebooks/book01/notes/note01?mode=write",
  );
  expect(requestedPresentationMode(new URLSearchParams("mode=readonly"))).toBe("readonly");
  expect(requestedPresentationMode(new URLSearchParams("mode=bogus"))).toBeUndefined();
});

test.each(["write", "readonly", "book"])("plain notebook links preserve the explicit %s mode", (mode) => {
  const current = `https://cloud.example/app/notebooks/book01/notes/note01?mode=${mode}`;
  expect(inheritPresentationMode("/app/notebooks/book01/notes/note02?view=tag&tag=wiki#intro", current)).toBe(
    `/app/notebooks/book01/notes/note02?view=tag&tag=wiki&mode=${mode}#intro`,
  );
  for (const href of [
    "/app/notebooks/book02/notes/note02",
    "https://other.example/app/notebooks/book01/notes/note02",
    "/app/notebooks/book01/notes/note02?mode=readonly",
    "/app/notebooks/book01/notes/note02?mode=versions",
    "http://[",
  ])
    expect(inheritPresentationMode(href, current)).toBe(href);
});

test("unselected presentation uses the target notebook default", () => {
  const href = "/app/notebooks/book01/notes/note02";
  expect(inheritPresentationMode(href, "https://cloud.example/app/notebooks/book01/notes/note01")).toBe(href);
});
