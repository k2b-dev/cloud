### The opened work had its chevrons and counts on different lines

- **What happened:** In the Preview, Valentin opened a turn's steps: the work line's chevron sat right after its time, the steps' chevrons at the row's end, and the counts of folded rows ("2 Schritte", "3-mal") on yet another line.
- **Root cause:** The work line had become as wide as its sentence (`width: fit-content`), folded rows (housekeeping, a file read in parts) had no row width of their own, and the steps used a wider gap before their chevrons than the work line.
- **Error class:** Rows of one stack each place their right-hand parts by their own width and gap instead of sharing one right edge.
- **Guard:** Every row of the opened work ends on the same edge (the row measure) with the same gap before its time or count and its chevron (`effects.css`). The chat gallery browser test opens a turn with folded rows at 1440 and 390 and checks that all chevrons and all times and counts share their right edges within 0.5 px, and that opening a row moves nothing above it.
