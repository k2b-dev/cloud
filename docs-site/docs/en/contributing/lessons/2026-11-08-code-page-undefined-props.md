### Optional page props set to undefined broke Code pages at run time

- **What happened:** A Code form written as `<Field.Number … error={errors.hours} />` passed `cld code check`, then the route failed with `code_page_data_only` whenever the field had no error.
- **Root cause:** The page types allow `undefined` for optional props, but `c.page` refused every `undefined` value while checking that the tree holds only data.
- **Error class:** A type contract that is looser than the runtime check it feeds, so checked source fails only when it runs.
- **Guard:** The page contract test draws a page whose optional props are `undefined` and still refuses a hole in a list.
