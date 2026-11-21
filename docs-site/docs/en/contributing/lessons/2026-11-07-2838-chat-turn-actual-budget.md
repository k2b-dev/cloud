### A chat turn allocated a full day's Code allowance

- **What happened:** One Code-started Gustav turn allocated the full default Code AI allowance, preventing later routine turns and text AI calls that day.
- **Root cause:** Admission treated the entire per-attempt reference allowance as the price of starting an asynchronous turn.
- **Error class:** Charging an allocation as actual usage across different execution lifecycles.
- **Guard:** The capability integration test admits three cheap turns, checks their actual inference cost, preserves the text AI allowance, and refuses a turn after the owner's interactive budget is spent. Separate cases cover both existing Code daily USD limits and retained cost attribution after chat deletion.
