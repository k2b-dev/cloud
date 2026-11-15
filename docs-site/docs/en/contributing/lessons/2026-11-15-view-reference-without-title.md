### A view table showed short ids instead of task names

- **What happened:** A table Gustav made of tasks showed "ZK3qUf" and two more short ids where the task titles belonged.
- **Root cause:** The capability returned each task's `ref` and `title` side by side; Gustav's script passed only `ref`, and a reference cell fell back to its id.
- **Error class:** An untrusted writer's missing field decided what every reader saw.
- **Guard:** Cloud names a view's untitled references when the chat reads the file, with the reading person's authority and in one batch (`view-names.ts` on the shared `resource-readers.ts`); a reference it cannot name shows as "Not available", never as its id. `view-names.test.ts` counts one registry read and one reader call per distinct reference, and `view-block.browser.test.ts` checks the table. The code-mode views guide still asks for the title.
