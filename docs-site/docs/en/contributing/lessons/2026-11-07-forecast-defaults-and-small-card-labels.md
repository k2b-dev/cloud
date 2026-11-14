### Check forecast defaults alongside the drawing

- **What happened:** The Liquidity forecast used steps, its threshold label overlapped the band, and its resting legend showed the final projection instead of today's balance. The bottom Y tick touched the first date in a phone-sized line card.
- **Root cause:** The example selected step interpolation and used a generated marker value that differed from its summary tile. Three legend hosts independently chose the last X; the threshold label occupied the data region. Responsive labels retained their font size without retaining their origin clearance.
- **Error class:** Chart annotations and default inspection state diverge from the user's reference date and available label space.
- **Guard:** Core tests compare smooth and stepped bounds and marker defaults. The actual desktop/phone fixture checks today's exact amount, all host legend defaults, curved bands, threshold clearance and origin tick boxes. Ordinary line SVG parity remains strict; the narrow-card spacing fix changes CSS only.
