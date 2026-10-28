### A notice check treated control icons as prose

- **What happened:** The notice check rejected the Close control's icon size ([#1754](https://github.com/k2b-dev/cloud/issues/1754)).
- **Root cause:** The size matcher ignored the control-icon context that the icon check already recognized.
- **Error class:** A visual rule confuses a control icon with prose.
- **Guard:** `notice-cards.test.ts` permits sized control icons but still rejects text sizes, palette colours, arbitrary colours and opacity overrides.
