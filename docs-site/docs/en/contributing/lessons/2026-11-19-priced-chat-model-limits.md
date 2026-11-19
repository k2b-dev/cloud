### Missing model limits hid the cause of failed alarms and Code chat calls

- **What happened:** A chat model could have a price without a context window. Alarms reported an exhausted daily budget, while Code received a generic refusal.
- **Root cause:** Catalog writes accepted incomplete priced models; the alarm scheduler reduced specific admission errors to `budget`, and the runner transport omitted translated refusal text.
- **Error class:** Incomplete configuration accepted at write time and loss of actionable failure reasons across boundaries.
- **Guard:** Catalog validation covers model and variant writes. Regression tests cover the standard 1 USD allowance, missing limits, durable alarm reasons, translated chat lines, and refusal text through the runner.
