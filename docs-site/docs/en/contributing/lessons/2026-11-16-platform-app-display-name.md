### The platform app showed people its maintainer name "Core"

- **What happened:** Gustav's work line read "In Notizbücher und Core nachgesehen", and admin lists named the platform app "Core", a word only maintainers use.
- **Root cause:** The platform app's display name in `packages/core/src/config.ts` was its package name, and every person-facing surface uses the catalog name.
- **Error class:** An internal package or role name used as a person-facing display name.
- **Guard:** None as a check, because the catalog name is free text the app author chooses; the convention is that a display name is a word the app's users know, and the chat's `app-neutral-assistant` rule keeps surfaces from patching names case by case.
