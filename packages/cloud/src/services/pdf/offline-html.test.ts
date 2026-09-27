import { describe, expect, test } from "bun:test";
import { offlineHtml } from "./offline-html";

const POLICY =
  "default-src 'none'; style-src 'unsafe-inline' file: data:; img-src file: data:; font-src file: data:; base-uri 'none'; form-action 'none'";
const OFFLINE_META = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${POLICY}">`;

describe("offline HTML", () => {
  test("puts the policy ahead of the caller's document", () => {
    const content = "<!doctype html><html><head><title>Invoice</title></head><body><p>Hi</p></body></html>";
    expect(offlineHtml(content)).toBe(`<!doctype html>${OFFLINE_META}${content}`);
  });

  test("keeps the caller's rendering mode", () => {
    expect(offlineHtml("<p>No doctype</p>")).toBe(`${OFFLINE_META}<p>No doctype</p>`);
    const legacy = '\n<!-- Invoice -->\n<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><p>Legacy</p>';
    expect(offlineHtml(legacy)).toBe(`<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">${OFFLINE_META}${legacy}`);
    const xhtml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"><p>XHTML</p>';
    expect(offlineHtml(xhtml)).toBe(`<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN">${OFFLINE_META}${xhtml}`);
    expect(offlineHtml("<!--><!---><!-- a --!><!doctype html><p>Empty comments</p>")).toStartWith(`<!doctype html>${OFFLINE_META}`);
    expect(offlineHtml("<p>Text</p><!doctype html>")).toStartWith(OFFLINE_META);
    expect(offlineHtml("<!--><p>Text</p>--><!doctype html>")).toStartWith(OFFLINE_META);
    expect(offlineHtml("<!-- open comment <!doctype html>")).toStartWith(OFFLINE_META);
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
        '<noscript><img src="http://remote.test/noscript"></noscript>',
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

  test("leaves the text around a removed element unchanged", () => {
    const html = offlineHtml('<<script></script>b>Bold</b> <<link rel="icon">i>Italic</i>');
    expect(html).toEndWith("<<!---->b>Bold</b> <<!---->i>Italic</i>");
  });

  test("removes MathML and the SVG elements that hold HTML", () => {
    const html = offlineHtml(
      [
        "<math><mi>x</mi></math>",
        "<svg><foreignObject><p>Note</p></foreignObject></svg>",
        "<svg><foreignobject>Note</foreignobject></svg>",
        "<svg><desc>Note</desc></svg>",
        "<p>Invoice</p>",
      ].join(""),
    );
    expect(html).not.toContain("<math");
    expect(html).not.toContain("<mi>");
    expect(html).not.toContain("Note");
    expect(html).toContain("<p>Invoice</p>");
  });

  test("keeps inline SVG shapes, images, links, and the document title", () => {
    const content =
      '<title>Invoice</title><svg width="8" height="8"><title>Chart</title><a href="https://example.com"><circle r="4"/></a><path d="M0 0"/><rect/><image href="data:image/png;base64,AA=="/><use href="#shape"/></svg>';
    expect(offlineHtml(content)).toBe(`${OFFLINE_META}${content}`);
  });

  test("keeps styles, images, links, and stylesheets that the policy confines", () => {
    const content =
      '<link rel="Stylesheet" href="styles.css"><style>h1 { color: red; }</style><img src="logo.png"><img src="data:image/png;base64,AA=="><a href="https://example.com">Terms</a>';
    expect(offlineHtml(content)).toBe(`${OFFLINE_META}${content}`);
  });
});
