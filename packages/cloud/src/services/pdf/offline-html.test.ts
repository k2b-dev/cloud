import { describe, expect, test } from "bun:test";
import { offlineHtml } from "./offline-html";

const POLICY =
  "default-src 'none'; style-src 'unsafe-inline' file: data:; img-src file: data:; font-src file: data:; base-uri 'none'; form-action 'none'";

describe("offline HTML", () => {
  test("puts the policy ahead of the caller's document", () => {
    const html = offlineHtml("<!doctype html><html><head><title>Invoice</title></head><body><p>Hi</p></body></html>");
    expect(html).toStartWith(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${POLICY}">`);
    expect(html).toEndWith("<!doctype html><html><head><title>Invoice</title></head><body><p>Hi</p></body></html>");
  });

  test("removes elements that run code, navigate, embed documents, or open connections", () => {
    const html = offlineHtml(
      [
        '<META http-equiv="refresh" content="0;url=http://remote.test/">',
        '<meta charset="iso-8859-1">',
        '<base href="http://remote.test/">',
        '<link rel="preload" as="image" href="http://remote.test/preload">',
        '<link rel="preconnect" href="http://remote.test">',
        '<link rel="dns-prefetch" href="//remote.test">',
        '<link rel="icon" href="http://remote.test/icon">',
        '<script src="http://remote.test/script.js"></script>',
        "<script>document.title = 'changed'</script>",
        '<svg><script href="http://remote.test/svg.js"></script></svg>',
        '<iframe src="http://remote.test/frame"></iframe>',
        '<iframe srcdoc="<p>remote.test</p>"></iframe>',
        '<frameset><frame src="http://remote.test/frame"></frameset>',
        '<object data="http://remote.test/object"></object>',
        '<embed src="http://remote.test/embed">',
        "<p>Invoice</p>",
      ].join(""),
    );
    expect(html).not.toContain("remote.test");
    expect(html).not.toContain("iso-8859-1");
    expect(html).not.toContain("changed");
    expect(html).toContain("<p>Invoice</p>");
    expect(html.match(/<meta /g)).toHaveLength(2);
  });

  test("keeps styles, images, links, and stylesheets that the policy confines", () => {
    const content =
      '<link rel="Stylesheet" href="styles.css"><style>h1 { color: red; }</style><img src="logo.png"><img src="data:image/png;base64,AA=="><a href="https://example.com">Terms</a>';
    expect(offlineHtml(content)).toEndWith(content);
  });
});
