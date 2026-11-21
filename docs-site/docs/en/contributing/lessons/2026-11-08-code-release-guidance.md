### Verify release guidance against the retained paths

- **What happened:** Upgrade guidance still described retired editors, omitted the staged startup commands and Runner prerequisites, and showed an unavailable Grids SDK method. The authoring Skill omitted supported chart kinds.
- **Root cause:** Guidance and examples were not checked again after the final application cut.
- **Error class:** Documentation drift across a coordinated release.
- **Guard:** The repository catalog check typechecks the Gustav export example against the real manifests and executes it through the code_run host with a fictional reply. App-local tests keep fictional providers. The chart contract checks the Skill's list against the schema. The deployment generator test requires a Mail application healthcheck matching Core, so the staged runbook waits for application readiness; a running container is insufficient. The runbook links the Runner prerequisites before the commands that start it. Use that sequence during the migration rehearsal.
