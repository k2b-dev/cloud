### Measure the approved frame at each viewport

- **What happened:** the App-PWA example retained the desktop maximum width but filled phone and tablet viewports, losing the approved outer margins.
- **Root cause:** the responsive CSS copied the content widths without the mockup's surrounding frame; the browser fixture also loaded styles in the reverse order from production.
- **Error class:** responsive mockup parity drift.
- **Guard:** browser measurements cover the frame width, top margin, minimum height and inner width at phone, tablet and desktop sizes in both themes, using the production stylesheet order.
