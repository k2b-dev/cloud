import { expect, test } from "bun:test";
import { markdown } from "./index";
import { katexHtml, katexSource } from "./katex-parity.test-fixture";

test("server math renders the shared browser parity reference immediately", () => {
  expect(markdown.renderSync(katexSource)).toBe(katexHtml);
});
