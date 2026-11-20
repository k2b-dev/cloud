### A detail block shows a byte size as a raw number

- **What happened:** The Files search preview showed a file's size as `2400000` instead of `2,4 MB` ([#3833](https://github.com/k2b-dev/cloud/issues/3833)).
- **Root cause:** The schema lets a `Detail` field carry the shared number `format`, and key figures apply it, but the `Detail` renderer wrote every value with `String(value)`. The shared formatter also only appended `B` as a unit, so a key figure with the same format read `2.400.000 B`.
- **Error class:** One block contract has several renderers, and only some of them honor a shared option.
- **Guard:** `DetailBlock.render.test.tsx` draws a `Detail` block in German and English and checks each formatted value against `formatDescriptionNumber`, the formatter key figures use. A renderer that ignores `format` or formats on its own fails the test.
