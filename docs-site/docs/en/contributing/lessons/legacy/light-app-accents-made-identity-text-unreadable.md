### Light app accents made identity text unreadable

- **What happened:** The yellow Notebooks accent produced text below 4.5:1 contrast on light surfaces.
- **Root cause:** Fixed CSS mixes adjusted every accent by the same amount without checking background contrast.
- **Error class:** Derived theme text color without a contrast guarantee.
- **Guard:** `app-color.test.ts` checks every declared app accent and edge colors against theme and selection surfaces, pins surface and default token values, and verifies the mildest passing clamp step. SSR and compiled stylesheet tests pin emission and scoped theme mappings.
