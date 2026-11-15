### A view table showed short ids instead of task names

- **What happened:** A table Gustav made of tasks showed "ZK3qUf" and two more short ids where the task titles belonged.
- **Root cause:** The capability returned each task's `ref` and `title` side by side; Gustav's script passed only `ref`, and a reference cell fell back to its id.
- **Error class:** An untrusted writer's missing field decided what every reader saw.
- **Guard:** Cloud names a view's untitled references when the chat reads the file, with the reading person's authority and in one batch (`view-names.ts` on the shared `resource-readers.ts`); a reference it cannot name shows as "Not available", never as its id. `view-names.test.ts` counts one registry read and one reader call per distinct reference, and `view-block.browser.test.ts` checks the table. The code-mode views guide still asks for the title.
- **Follow-up:** Naming at read time changed the text length of a record's reference, and the record no longer matched the summary it reserved when written, so it showed as unavailable. A reference's length no longer counts towards that match; `view-file.test.ts` loads a record whose reference was named on reading and keeps rejecting a changed plain value.
