### Plot measured windows, not the aggregate, and show each figure once

- **What happened:** The speedtest result showed the download three times (gauge, check row, tile), left an empty slot in a row of five tiles, and ended each history line in a vertical cliff.
- **Root cause:** The view plotted the phase-complete event, whose rate is the phase aggregate, as if it were one more 250 ms window. It also classified a window ending exactly at warmup as measured, while the engine counts only windows that start at or after warmup.
- **Error class:** A summary value is drawn as a sample, and a display classifies data differently from the engine that produced it.
- **Guard:** The Tools speedtest browser flow reads the rendered chart points. Measured series have no zero and no step above 30 % between windows, and ramp-up comes before and stays thinner than measured windows. The same flow checks one gauge reading plus four distinct, unclipped tiles, equal tile heights without an empty slot, and one-line mode labels in German and English at 390 and 1440 px.
