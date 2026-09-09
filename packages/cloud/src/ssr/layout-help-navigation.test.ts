import { describe, expect, test } from "bun:test";
import type { HelpDocumentManifest } from "@k2b/cloud/shared";
import { adjacentHelpDocuments, focusHelpArticleHeading, resetHelpArticleScroll } from "./layout-help-navigation";

const documents = ["start", "work", "troubleshooting"].map(
  (id, order): HelpDocumentManifest => ({
    id,
    title: id,
    order,
    searchUrl: "/help/search",
    url: `/help/${id}`,
  }),
);

describe("adjacentHelpDocuments", () => {
  test("follows the explicit manifest order", () => {
    expect(adjacentHelpDocuments(documents, "start")).toEqual({
      previous: null,
      next: documents[1]!,
    });
    expect(adjacentHelpDocuments(documents, "work")).toEqual({
      previous: documents[0]!,
      next: documents[2]!,
    });
    expect(adjacentHelpDocuments(documents, "troubleshooting")).toEqual({
      previous: documents[1]!,
      next: null,
    });
  });

  test("returns no navigation for non-document topics", () => {
    expect(adjacentHelpDocuments(documents, "shortcuts")).toEqual({
      previous: null,
      next: null,
    });
  });

  test("resets the stored and visible article position before navigation", () => {
    const session = { articleScrollTop: 840 };
    const scroller = { scrollTop: 840 };

    resetHelpArticleScroll(session, scroller);

    expect(session.articleScrollTop).toBe(0);
    expect(scroller.scrollTop).toBe(0);
  });

  test("focuses the article heading without moving the reset viewport", () => {
    let options: FocusOptions | undefined;

    focusHelpArticleHeading({
      focus: (value) => {
        options = value;
      },
    });

    expect(options).toEqual({ preventScroll: true });
  });
});
