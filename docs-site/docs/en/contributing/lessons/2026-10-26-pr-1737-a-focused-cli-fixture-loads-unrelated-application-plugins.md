### A focused CLI fixture loads unrelated application plugins

- **What happened:** Installing the full first-party inventory adds discovery and fixture work to a standalone opener test that starts multiple CLI processes under one deadline.
- **Root cause:** The standalone opener test used the full first-party plugin inventory despite not consuming it.
- **Error class:** A focused CLI fixture loads unrelated application plugins
- **Guard:** Test: Cloud CLI `index.test.ts` runs URL validation, unavailable-host checks and opener outcomes with only the custom browser plugin; all assertions and the five-second timeout remain unchanged. See #1762.
