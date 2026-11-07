### Carry balances through one continuous canvas

- **What happened:** Paging replaced one month's settlement diagram with another, hiding the connection between closing and opening balances.
- **Root cause:** Each period had its own layout and scale. Equal balances shared a colour but did not share a continuous band.
- **Error class:** A navigation model concealed continuity in the data.
- **Guard:** BalanceFlow layout tests compare the closing/opening edge, baseline, thickness and common scale at every boundary. The browser guard checks the newest month before scripts run, unchanged SVG after navigation, one normal-width shared balance node and combined accessible tooltip, no native titles, non-overlapping IBM Plex label boxes at 1440/1200 px, neighbour peeks on phones, compact 44 px amount rows with separators and a diagram-to-list gap of at most 10 px, longer-list scroll without frame growth, scroll inspection, both motion preferences and real state boxes.
