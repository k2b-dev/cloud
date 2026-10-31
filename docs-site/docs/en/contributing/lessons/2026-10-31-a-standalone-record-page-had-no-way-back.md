### The Files execution record had no way back

- **What happened:** The execution record page (`/app/filesv2/execution/<activityId>`) showed only its title: no back link, no sidebar, no close, and Alt+Up did nothing. Only the app rail led away (#2243).
- **Root cause:** The page gave the shell `[Files, record]`. The shell drops the app root by rule, so no level remained to go up to, and the page has no workspace sidebar that could lead back instead.
- **Error class:** A standalone page below an app view names only the app root, so its one necessary way back disappears.
- **Guard:** The record names Activity, where its entry is listed, as the level above; `execution-page.render.test.ts` checks the derived trail leads up to Activity.
