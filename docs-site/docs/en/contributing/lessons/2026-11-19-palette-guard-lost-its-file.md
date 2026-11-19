### The fallback icon palette lost its color guard

- **What happened:** The fallback icon palette held a violet (`#7c3aed`), although violet and plum mean AI, and a zinc grey (`#52525b`) that read as black and fell below 3:1 in dark mode. The `ai-color` check passed.
- **Root cause:** The palette moved from `AppLaunchpadPanel.tsx` to `app-icon-style.ts`. The check still read the old file, found no palette, and reported nothing. Its 20° hue distance from plum also let violet (49° away) through.
- **Error class:** A check that silently passes when its target moves
- **Guard:** The `ai-color` check reads the palette from `app-icon-style.ts`, reports a missing palette, and rejects every palette tone from violet to plum (270–360° OKLCH hue) and every grey tone (`scripts/checks/ai-color.test.ts`).
