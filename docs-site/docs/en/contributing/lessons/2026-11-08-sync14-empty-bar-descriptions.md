### A defaulted chart field hid the explicit empty state

- **What happened:** A Code page's empty chart showed an unsupported-view notice instead of its supplied empty sentence after the main sync.
- **Root cause:** The bar schema began defaulting missing data to an empty array. The description resolver recognized explicit empty charts only after parsing failed, so the successful parse instead treated the empty sentence as an unknown chart field.
- **Error class:** Schema defaults bypassed a semantic state recognized through validation failure.
- **Guard:** Description panel render tests cover explicit empty forms for both line and bar charts; the existing Core page render test verifies the supplied empty sentence at the page boundary.
