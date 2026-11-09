import { expect, test } from "bun:test";
import { renderedText, withoutComments } from "./rendered-markup";

test("markup assertions parse comments and quoted tag boundaries", () => {
  const markup = '<span title="a > b">feat<!-- multi\nline > comment -->code</span>';
  expect(withoutComments(markup)).toBe('<span title="a > b">featcode</span>');
  expect(renderedText(markup)).toBe("featcode");
  expect(renderedText("<b>one</b><i>two</i>", " ")).toBe(" one  two ");
  expect(renderedText("<input><br><svg><path /></svg>", " ")).toBe("     ");
});
