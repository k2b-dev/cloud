import { describe, expect, test } from "bun:test";
import { parseSizedMarkdownImage } from "./markdown-image";
import { DOCUMENTED_IMAGE_FORMS } from "./markdown-image.fixtures";

describe("parseSizedMarkdownImage", () => {
  for (const fixture of DOCUMENTED_IMAGE_FORMS) {
    test(fixture.name, () => {
      const image = parseSizedMarkdownImage(fixture.markdown);
      if (fixture.width === null && fixture.height === null) {
        expect(image).toBeNull();
        return;
      }
      expect(image).toMatchObject({
        length: fixture.markdown.length,
        alt: fixture.alt,
        href: fixture.href,
        title: fixture.title,
        width: fixture.width,
        height: fixture.height,
      });
      expect(fixture.markdown.slice(image!.hrefFrom, image!.hrefTo)).toBe(fixture.href);
      if (fixture.title === null) {
        expect(image!.titleFrom).toBeNull();
        expect(image!.titleTo).toBeNull();
      } else {
        expect(fixture.markdown.slice(image!.titleFrom!, image!.titleTo!)).toBe(`"${fixture.title}"`);
      }
    });
  }

  for (const source of [
    "![a](attach://GHI789 =x)",
    "![a](attach://GHI789\n=400x)",
    "![a](attach://GHI789 =400x",
    "![a](attach://GHI789)",
    '![a](attach://GHI789 "t" =400x)',
    '![a](attach://GHI789 =400x\n"t")',
    '![a](attach://GHI789 =400x"t")',
    '![a](attach://GHI789 =400x "unclosed)',
    '![a](attach://GHI789 =400x "two\nlines")',
    "![a\nb](attach://GHI789 =400x)",
    "![a](https://example.test/a(b).png =400x)",
    "prefix ![a](attach://GHI789 =400x)",
  ]) {
    test(`rejects ${JSON.stringify(source)}`, () => {
      expect(parseSizedMarkdownImage(source)).toBeNull();
    });
  }

  test("accepts spaces and tabs, an empty alt and title, and zero dimensions", () => {
    const source = '![](attach://GHI789 \t =0x0\t "" \t)';
    const image = parseSizedMarkdownImage(source)!;
    expect(image).toMatchObject({ length: source.length, alt: "", width: 0, height: 0, title: "" });
    expect(source.slice(image.hrefFrom, image.hrefTo)).toBe("attach://GHI789");
    expect(source.slice(image.titleFrom!, image.titleTo!)).toBe('""');
  });

  test("does not consume text after the closing parenthesis", () => {
    const markdown = '![Plan](attach://GHI789 =400x "Ground floor")';
    expect(parseSizedMarkdownImage(`${markdown} trailing text`)?.length).toBe(markdown.length);
  });
});
