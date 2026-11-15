### A phone prompt sheet let the suggestion list cover the data source

- **What happened:** With #3395 a Weather "Add place" prompt became a bottom sheet on phones. Its search field then sat at the screen's bottom edge, the suggestion list opened upwards, and it covered the Geoapify and OpenStreetMap attribution printed above the field. The 390 px browser test caught it in CI (unit shard 7); in the old centred dialog the list opened downwards and left the line free.
- **Root cause:** The attribution was a separate line above the field instead of part of the results it credits, so whether it stayed visible depended on which way the list opened.
- **Error class:** Content that must stay visible next to a floating list placed beside the field instead of inside the list, so a change of frame or of the list's direction covers it.
- **Guard:** `weather-geo.browser.test.ts` hit-tests the attribution link while suggestions show at 390, 768 and 1440 px; the attribution now uses the Combobox `footer`, which the Combobox documents for a result's source.
