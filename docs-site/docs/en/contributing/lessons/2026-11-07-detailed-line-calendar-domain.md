### Date labels need a time scale

- **What happened:** A daily October line showed September and November ticks, empty strips at both ends, and a date label touching the bottom Y tick.
- **Root cause:** The portable adapter formatted numeric millisecond ticks as dates and rounded annotation domains to numeric steps.
- **Error class:** Date formatting alone does not provide calendar-aware scale semantics.
- **Guard:** Opted-in date lines reuse the existing round calendar tick logic over the exact instant range, preserve explicit domains and anchor edge labels into the plot. Pure/adapter tests cover October endpoints and weekly/monthly ticks; desktop/phone browser guards check label clearance. Ordinary lines retain strict immutable SVG parity; changing their time-axis defaults requires a separate product decision.
