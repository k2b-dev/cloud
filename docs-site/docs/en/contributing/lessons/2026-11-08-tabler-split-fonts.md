### Parse the icon font faces instead of matching one source list

- **What happened:** The dependency update to `@tabler/icons-webfont` 3.50 (#2715) failed the `@k2b/ui` build: "could not reduce the Tabler preset to WOFF2".
- **Root cause:** Tabler 3.50 splits its font into 48 unicode-range faces with one WOFF2 file each. The build matched the single face of 3.48 with one regular expression, and Core versioned only the first font file. Bun would also have inlined the small split files as a megabyte of CSS, and no split face covers the space, so every icon would sit on the fallback font's baseline.
- **Error class:** An asset pipeline that matches one dependency's exact output format breaks, or degrades without an error, when that format changes.
- **Guard:** `packages/ui/scripts/tabler-fonts.test.ts` builds the preset from 3.48 and 3.50 fixtures and fails on a face without a WOFF2 file or an inlined font. `tabler-assets.test.ts` checks every font file Core serves, and `tabler.browser.test.ts` checks that icons keep their position in their box.
