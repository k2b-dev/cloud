import { describe, expect, test } from "bun:test";
import { LOGIN_PAGE_CSP, type LoginPageOutcome, loginPageHtml, loginPageResponse } from "./login-page";

const outcomes: ReadonlyArray<readonly [LoginPageOutcome, number]> = [
  ["success", 200],
  ["denied", 200],
  ["mismatch", 400],
  ["failed", 400],
];

for (const locale of ["en", "de"]) {
  describe(`login page (${locale})`, () => {
    for (const [outcome, status] of outcomes) {
      test(`${outcome} is self-contained and has the expected response`, async () => {
        const options = { locale, detail: outcome === "failed" ? "The authorization server could not complete the sign-in." : undefined };
        const html = loginPageHtml(outcome, options);
        expect(html).toMatchSnapshot();
        expect(html).not.toContain("<script");
        expect(html).not.toContain("http://");
        expect(html).not.toContain("https://");
        expect(html).not.toContain("<link");
        expect(html).not.toContain("<img");
        expect(new TextEncoder().encode(html).byteLength).toBeLessThan(4000);

        const response = loginPageResponse(outcome, options);
        expect(response.status).toBe(status);
        expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(response.headers.get("content-security-policy")).toBe(LOGIN_PAGE_CSP);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.text()).toBe(html);
      });
    }

    test("escapes authorization server details", () => {
      const detail = `<script>alert("x")</script>&'`;
      const html = loginPageHtml("failed", { locale, detail });
      expect(html).not.toContain(detail);
      expect(html).not.toContain("<script");
      expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
    });
  });
}
