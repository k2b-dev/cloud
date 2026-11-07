### Carry balances through one continuous canvas

- **What happened:** Paging replaced one month's settlement diagram with another, hiding the connection between closing and opening balances.
- **Root cause:** Each period had its own layout and scale. Equal balances shared a colour but did not share a continuous band.
- **Error class:** A navigation model concealed continuity in the data.
- **Guard:** BalanceFlow layout tests compare the closing/opening edge, baseline, thickness and common scale at every boundary. The browser guard checks the newest month before scripts run, unchanged SVG after navigation, scroll inspection, both motion preferences and real state boxes at desktop and phone widths.
