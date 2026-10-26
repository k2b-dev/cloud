### Clearing a text field lost keyboard focus

- **What happened:** The focused clear button disappeared with the value without moving focus back into the field, so keyboard focus fell to the page.
- **Root cause:** The input was focused only after the clear callback ran, when the button no longer existed.
- **Error class:** A focused control is removed from the DOM before focus moves to a stable target.
- **Guard:** Browser tests clear a field by keyboard and type again, and verify that a caller can deliberately move focus in its clear callback.
