### Include both public label layouts in the subgrid contract

- **What happened:** The label-row Slider preserved control alignment in the browser, but an existing render test still expected the old label-only selector as source text.
- **Root cause:** The CSS selector was extended to include label rows without updating its source contract.
- **Error class:** A selector contract omits an additive public layout.
- **Guard:** The existing choice-input render test now requires both label forms on subgrid row one. The Slider browser test checks that controls with either label form stay aligned and values do not move after changes or reset.
