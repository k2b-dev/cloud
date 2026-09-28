import { expect, test } from "bun:test";
import { selectHtml } from "./select-html";

test("nested matches each keep their own text content", async () => {
  const html = '<div class="a">before <p class="a">inner</p> after</div><div class="a">next</div><br class="a" />';

  expect((await selectHtml(html, ".a")).map((match) => match.text)).toEqual(["before inner after", "inner", "next", ""]);
});
