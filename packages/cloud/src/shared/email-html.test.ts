import { describe, expect, test } from "bun:test";
import { sanitizeEmailHtml } from "./email-html";

describe("email HTML sanitizer", () => {
  test("keeps quotes and preformatted blocks with only their style attribute", () => {
    for (const tag of ["blockquote", "pre"]) {
      expect(
        sanitizeEmailHtml(
          `<${tag} style="color:#52525b" class="x" id="x" onclick="alert(1)" cite="https://example.test" data-x="x">text</${tag}>`,
        ),
      ).toBe(`<${tag} style="color:#52525b">text</${tag}>`);
    }
  });

  test("keeps a divider with only its style attribute", () => {
    expect(sanitizeEmailHtml('<p>a</p><hr style="border-top:1px solid #d4d4d8" class="x" onclick="alert(1)" id="y"><p>b</p>')).toBe(
      '<p>a</p><hr style="border-top:1px solid #d4d4d8" /><p>b</p>',
    );
  });

  test("keeps strikethrough and table alignment without admitting event handlers or unsafe links", () => {
    expect(sanitizeEmailHtml('<del class="x" onclick="alert(1)">old</del>')).toBe("<del>old</del>");
    expect(sanitizeEmailHtml('<table><tr><th align="center">A</th><td align="right" onclick="alert(1)">B</td></tr></table>')).toBe(
      '<table><tr><th align="center">A</th><td align="right">B</td></tr></table>',
    );
    expect(sanitizeEmailHtml('<del><a href="javascript:alert(1)">old</a></del><script>alert(1)</script>')).toBe(
      "<del><a>old</a></del>",
    );
  });

  test("keeps phone links like web and mail links", () => {
    for (const href of ["tel:+49731000000", "tel:+49 731 000000", "tel:+49-731-000000;ext=12", "tel:(0731)%20000.000", "TEL:110"]) {
      expect(sanitizeEmailHtml(`<a href="${href}">Call</a>`)).toBe(`<a href="${href}">Call</a>`);
    }
  });

  test("drops a tel: link that holds no phone number and keeps its text", () => {
    for (const href of ["tel:", "tel:+", "tel:call-me", "tel:+49;foo=bar", "tel:+49<script>", "t\tel:abc", "tel:%E0%A4%A"]) {
      expect(sanitizeEmailHtml(`<a href="${href}">Call</a>`)).toBe("<a>Call</a>");
    }
  });

  test("drops a link address that hides its scheme in an HTML comment", () => {
    for (const href of ["te<!--x-->l:nope", "tel<!---->:nope", "https://example.test/<!--x-->"]) {
      expect(sanitizeEmailHtml(`<a href="${href}">Call</a>`)).toBe("<a>Call</a>");
    }
  });

  test("still drops other schemes", () => {
    expect(sanitizeEmailHtml('<a href="javascript:alert(1)">x</a> <a href="sms:+49">y</a>')).toBe("<a>x</a> <a>y</a>");
  });
});
