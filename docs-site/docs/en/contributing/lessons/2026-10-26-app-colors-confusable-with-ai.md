### App colors confusable with the AI accent

- **What happened:** Cyan means AI in Cloud, but IPA Hosts and Gateway Ops used cyan accents, and API Docs, Capabilities, Core, Files, and a launchpad fallback tile used cyan or sky gradient stops. People could not tell an app color from an AI surface.
- **Root cause:** App colors were chosen one app at a time, and nothing compared them with `--k2b-ai-accent` after cyan became the AI color.
- **Error class:** App color confusable with a reserved semantic color
- **Guard:** The `ai-color` check (`scripts/checks/ai-color.ts`) reads both `--k2b-ai-accent` values and fails when an app `appearance` color or a launchpad fallback color sits within 20° of OKLCH hue of them. Near-gray colors pass; the Assistant app is exempt.
