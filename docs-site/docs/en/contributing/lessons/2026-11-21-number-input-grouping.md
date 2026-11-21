### A number input cut grouped amounts without an error

- **What happened:** `NumberInput` turned a typed or pasted `2.977,17` into `2.97` in German, `2,977.17` into `2.97` in English and `1.234.567,89` into `1.23`. The field showed no error, and the parent received the wrong value. Core admin AI prices and budgets with `step={0.01}` were among the affected fields (#3897).
- **Root cause:** The input filter read the first `.` or `,` as the decimal separator, dropped every later mark, and cut the fraction to `decimalPlaces` while typing. It did not know the locale's grouping mark, so a grouping mark moved the decimal point.
- **Error class:** An input normalizer that discards characters it cannot place, which silently changes the magnitude of a value instead of refusing the text.
- **Guard:** `packages/ui/test/number-input-grouping.behavior.test.ts` covers grouped German and English amounts, key-by-key typing, a paste with a currency sign, refused text that keeps its text, shows an error and commits nothing, a trailing minus, and Enter in a form. `NumberInput` now reads the whole text with the locale's marks and refuses text that fits no reading.
