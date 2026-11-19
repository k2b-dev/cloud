### Carry alarm provenance through every origin consumer

- **What happened:** After a branch sync, the message source chip and Assistant queue failed typechecking when they received alarm origins.
- **Root cause:** The chip treated every non-person, non-automation origin as a chat with an optional link. The queue repeated the older three-kind origin type, and the display projection dropped the planned alarm time.
- **Error class:** A discriminated-union extension reaches consumers that still assume an older set of variants.
- **Guard:** The queue uses the public origin type. Projection tests preserve `scheduledAt`; queue and history render tests cover alarm icons, localized names and the planned time in the reader's time zone. The chip handles alarms before reading link fields.
