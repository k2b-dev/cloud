### A Git fixture assumes an empty directory survives checkout

- **What happened:** The independent-lesson merge test failed in CI with `ENOENT` before writing the second branch's lesson.
- **Root cause:** Checking out the original branch removed the first lesson and its now-empty directory. Git does not track empty directories.
- **Error class:** A filesystem fixture assumes directory state survives a Git checkout.
- **Guard:** `docs-site/scripts/lessons.test.ts` recreates the lesson directory after changing branches and exercises the real merge and all Fibel content surfaces.
