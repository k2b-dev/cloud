### A component drops its classList on the first render

- **What happened:** The note PDF dialog showed the data notice and the warning "0 items are not in the PDF" on top of each other in one cell. The Contacts favorite button showed neither its accent nor its dimmed color until the first toggle.
- **Root cause:** `@k2b/ui` components spread their rest props and then set their own `class`. Solid applies the spread `classList` first, and the later `className` write erases the toggled classes. The classes came back only when a `classList` value changed.
- **Error class:** A component prop that only works when Solid applies attributes in a certain order.
- **Guard:** Convention UI-26 and the `component-class-list` check rejects `classList` on components; pass one computed `class` instead. The note PDF dialog behavior test checks that only one of the two notices is visible before and after the export.
