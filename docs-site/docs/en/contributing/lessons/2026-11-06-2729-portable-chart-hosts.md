### Bar charts depended on the component wrapper to remain drawable

- **What happened:** Category hit areas painted black in PDF and app frames, horizontal bars failed in app frames, Chat rejected stacked layouts, and dense grouped bars disappeared.
- **Root cause:** New marks relied on scoped component CSS, two consumers did not handle the additive description, and a fixed inner gap consumed narrow bars.
- **Error class:** A portable renderer is verified only through its component host, leaving transport, stylesheet, and geometry assumptions unchecked.
- **Guard:** `chart-bars-family.browser.test.ts` checks computed fills without the component wrapper and with only base CSS. `cloud-lib.test.ts` renders horizontal app-frame charts, `default-tools.test.ts` parses bar layouts, and bar-family tests check dense widths, missing totals, locale, headers, and bounded legends.
