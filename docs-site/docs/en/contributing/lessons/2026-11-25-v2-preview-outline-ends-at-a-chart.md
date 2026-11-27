### The text outline of a v2 screen ended at its first chart

- **What happened:** `bun packages/ui/scripts/v2-preview.ts <screen> --text` printed the outline of the Valkey screen of gateway-ops only up to the Canvas with its chart; every section after it was missing, without a warning.
- **Root cause:** The text mode parses the server markup with happy-dom. A chart's SVG brings a `<style>` element, and happy-dom drops everything after a `<style>` inside an `<svg>`.
- **Error class:** A tool parses markup with a DOM library that does not follow the HTML parser in foreign content (SVG), so its view of the page silently loses parts.
- **Guard:** The text mode removes `<style>` elements before it parses (the outline reads no styles). `packages/ui/scripts/v2-preview.test.ts` outlines a screen with a section after a chart and expects that section.
