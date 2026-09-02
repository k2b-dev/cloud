import { expect, test } from "bun:test";
import { requestedPresentationMode, withPresentationMode } from "./presentation-url";

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
