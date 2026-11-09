### Keep the waterfall closing label when thinning categories

- **What happened:** The phone-sized Liquidity waterfall hid its closing date together with intermediate categories.
- **Root cause:** Responsive category thinning treated the final total like an intermediate step.
- **Error class:** Responsive density reduction removes a semantic endpoint.
- **Guard:** Keep the closing label unconditional, align it inside the right plot edge and reserve its space when thinning nearby steps. Pure SVG and responsive core tests cover a seven-bar phone case; the existing desktop-to-phone browser guard now asserts the closing label remains visible and labels do not overlap.
