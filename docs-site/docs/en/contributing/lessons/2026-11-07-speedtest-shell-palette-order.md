### Exercise app styling in the shell stylesheet order

- **What happened:** The speedtest warmup line and its legend became violet in the Cloud shell although the component gallery showed a neutral line.
- **Root cause:** The browser fixture loaded app styling after the global palette; Cloud serves those stylesheets in the opposite order. Equally specific SVG rules and the global legend palette therefore replaced the per-chart setting.
- **Error class:** A component fixture hides a production CSS cascade difference.
- **Guard:** The speedtest browser suite loads app CSS before shared Cloud CSS and checks the warmup palette on its container, rendered SVG and shared legend. The existing chart palette customization now scopes all three consistently.
