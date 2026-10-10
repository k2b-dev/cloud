import { describe, expect, test } from "bun:test";
import { sanitizeEmailHtml } from "./email-html";

describe("email HTML sanitizer", () => {
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

  test("still drops other schemes", () => {
    expect(sanitizeEmailHtml('<a href="javascript:alert(1)">x</a> <a href="sms:+49">y</a>')).toBe("<a>x</a> <a>y</a>");
  });
});
