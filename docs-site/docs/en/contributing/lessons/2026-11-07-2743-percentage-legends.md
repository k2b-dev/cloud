### Percentage legends summed independent periods

- **What happened:** A newsletter matrix printed more than 500% opened because its legend added monthly shares.
- **Root cause:** Count totals and period rates used the same legend aggregation.
- **Error class:** Aggregating non-additive measurements across categories.
- **Guard:** Percentage descriptions select latest-category legend values. Direct chart calls can set `legendValues="latest"`. Layout and adapter tests cover latest values, count totals and missing latest observations; the browser guard checks cursor values and restoration after Escape.
