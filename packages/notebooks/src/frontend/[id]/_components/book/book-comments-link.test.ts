import { expect, test } from "bun:test";
import { commentsHref } from "./BookCommentsLink.island";

test("Book's comments entry opens Read at the first comment of the same note", () => {
  expect(commentsHref("/app/notebooks/book01/notes/note01?mode=book#intro")).toBe(
    "/app/notebooks/book01/notes/note01?mode=readonly&annotation=first",
  );
  expect(commentsHref("/app/notebooks/book01/notes/note01")).toBe("/app/notebooks/book01/notes/note01?mode=readonly&annotation=first");
});
