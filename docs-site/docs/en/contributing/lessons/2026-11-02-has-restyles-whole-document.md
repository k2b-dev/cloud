### One selector rule made every click restyle the whole document

- **What happened:** Clicking a conversation in a mailbox took about 1.8 s on a desktop, while the server answered in 26 ms. The click ran several style passes over about 9,500 elements of about 200 ms each.
- **Root cause:** 18 rules in six groups had a `:has()` followed by a last part that names no class, id, attribute or element, such as `:where(html:has(.k2b-mobile-shell) *)` or `:has(> .a) > :not(.b)`. Each of them alone caused the full pass; Blink appears to share one invalidation set across `:has()`, though only the measurements back that, not its source. Removing any one group changed nothing, because the others still did it.
- **Error class:** A selector that looks local but widens style invalidation for the whole page, invisible in small test pages.
- **Guard:** The `css-has-scope` rule refuses this selector shape and Tailwind's `group-has-` and `peer-has-` variants.
