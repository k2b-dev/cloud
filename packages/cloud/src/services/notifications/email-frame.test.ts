import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as settings from "../settings";
import { coreSettings } from "../settings/api";
import { prepareNotificationEmail } from "./email-frame";

let read: ReturnType<typeof spyOn<typeof settings, "get">>;
let logo: ReturnType<typeof spyOn<typeof coreSettings, "get">>;
beforeEach(() => {
  read = spyOn(settings, "get").mockResolvedValue("Test Cloud").mockResolvedValueOnce("example.test");
  logo = spyOn(coreSettings, "get").mockResolvedValue("https://example.test/logo.svg");
});
afterEach(() => {
  read.mockRestore();
  logo.mockRestore();
});

// Golden markup copied from the previous buildHtml, including whitespace.
const previousFrame = await Bun.file(new URL("./email-frame.fixture.html", import.meta.url)).text();
test("content-only mail keeps the exact previous frame and sanitized text", async () => {
  const rendered = await prepareNotificationEmail({ content: "Hello <strong>reader</strong><script>bad()</script> & friend" });
  expect(rendered).toEqual({
    html: previousFrame.replace("{{body}}", "<p>Hello reader &amp; friend</p>"),
    text: "Hello reader &amp; friend",
  });
});
test("raw HTML keeps the exact previous frame and sanitization", async () => {
  const rendered = await prepareNotificationEmail({
    rawHtml: '<p onclick="bad()">Hello <strong>reader</strong></p><script>bad()</script>',
    content: "Plain",
  });
  expect(rendered).toEqual({ html: previousFrame.replace("{{body}}", "<p>Hello <strong>reader</strong></p>"), text: "Plain" });
});
test("HTML-only mail derives decoded text with sensible block spacing", async () => {
  const { text } = await prepareNotificationEmail({
    rawHtml:
      "<h1>A &amp; B</h1><p>caf&eacute; &copy; &#x1f600;<br> next&nbsp;line</p><ul><li>&lt;item&gt;</li><li>&amp;lt;literal&amp;gt;</li></ul><script>bad()</script>",
  });
  expect(text).toBe("A & B café © 😀 next line <item> &lt;literal&gt;");
});
test("raw HTML pre blocks wrap by default and keep sender styles last", async () => {
  const { html } = await prepareNotificationEmail({
    rawHtml: '<pre><code>const value = 42;</code></pre><pre style="white-space:pre;overflow-wrap:normal;color:red;">styled</pre>',
  });
  expect(html).toContain('<pre style="white-space:pre-wrap;overflow-wrap:break-word"><code>const value = 42;</code></pre>');
  expect(html).toContain(
    '<pre style="white-space:pre-wrap;overflow-wrap:break-word;white-space:pre;overflow-wrap:normal;color:red">styled</pre>',
  );
});
test("raw HTML pre blocks still strip scripts and event handlers", async () => {
  const { html, text } = await prepareNotificationEmail({
    rawHtml:
      '<div onclick="bad()"><script>bad()</script><pre onclick="bad()"><code onclick="bad()">safe</code><script>bad()</script></pre></div>',
  });
  expect(html).toContain('<div><pre style="white-space:pre-wrap;overflow-wrap:break-word"><code>safe</code></pre></div>');
  expect(html).not.toContain("<script");
  expect(html).not.toContain("onclick");
  expect(html).not.toContain("bad()");
  expect(text).toBe("safe");
});
test.each(["pre", "blockquote"])("HTML-only mail separates %s from the following paragraph", async (tag) => {
  const { text } = await prepareNotificationEmail({ rawHtml: `<${tag}>a</${tag}><p>b</p>` });
  expect(text).toBe("a b");
});
test("empty mail still has a text part and an optional logo", async () => {
  logo.mockResolvedValue("");
  const { html, text } = await prepareNotificationEmail({});
  expect(text).toBe("");
  expect(html).not.toContain("<img");
  expect(html).toContain("https://example.test/legal/privacy");
});
