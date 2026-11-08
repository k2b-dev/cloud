### Verify release guidance against the retained paths

- **What happened:** Upgrade guidance still described retired editors, omitted the staged startup commands and Runner prerequisites, and showed an unavailable Grids SDK method. The authoring Skill omitted supported chart kinds.
- **Root cause:** Guidance and examples were not checked again after the final application cut.
- **Error class:** Documentation drift across a coordinated release.
- **Guard:** The Gustav export example compiles through the code_run host with the real Grids manifest and executes with a fictional reply. The chart contract checks the Skill's list against the schema. The upgrade runbook owns the staged Core, Mail and remaining-service readiness checks and links the Runner prerequisites; use that sequence during the migration rehearsal.
