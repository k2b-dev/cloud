### A date line's axis started before its first value

- **What happened:** A line over November dates labelled its axis from "30. Okt.", two days before its first value.
- **Root cause:** Only detailed lines took the time axis; an ordinary line over dates drew a number axis and rounded its span out to a whole millisecond step.
- **Error class:** Dates measured on a number axis.
- **Guard:** Every portable date line takes the time axis over the plotted span (`charts.ts` in `@k2b/editor`); `line-forecast.test.ts` asserts the first label of an ordinary date line, and `view-block.browser.test.ts` that no label lies before the first value.
