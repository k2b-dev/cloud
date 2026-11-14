### Fixed SVG gutters can clip phone chart labels

- **What happened:** A 390 px forecast chart clipped currency ticks even though the desktop drawing was readable.
- **Root cause:** The plot gutter shrank with the SVG while CSS retained the tick text's physical size.
- **Error class:** Responsive geometry and text using different coordinate scales.
- **Guard:** `line-forecast.browser.test.ts` measures currency labels against the chart bounds at 390 and 1440 px. Outlook SVGs expose their label room; CSS adds only the inset missing at the actual width, without a client measurement or a permanent wide-screen margin.
