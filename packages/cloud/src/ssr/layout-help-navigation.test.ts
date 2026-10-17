import { describe, expect, test } from "bun:test";
import { focusHelpArticleHeading, resetHelpArticleScroll } from "./layout-help-navigation";

describe("Help article navigation", () => {
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
