### The flat build restyled screens instead of rebuilding them

- **What happened:** Cloud 0.84 shipped the flat build of `@k2b/ui` and its apps. In review the screens did not match the approved mockups, and the maintainer rolled the UI back: it went back to the look of 0.83, while the behavior, backend and test work of 0.84 stayed.
- **Root cause:** Each screen kept its old component tree and got new tokens, hairlines and radius roles laid over it. The mockups had a different structure, so the result was neither the old UI nor the new design, and it took many follow-up fixes such as status rows, edge fades and layout self-check exceptions.
- **Error class:** A new design language is applied as a restyle of the existing screens rather than as a rebuild from the approved structure, and a defect-free result is taken as clearance.
- **Guard:** Convention: a redesign rebuilds each screen from the mockup's structure and clears it against the mockup's numbers, not by an absence of defects. The flat foundation, its checks and the layout self-check stay on `archive/cloud-flach-0b0b574381` as the starting point for a second attempt.
