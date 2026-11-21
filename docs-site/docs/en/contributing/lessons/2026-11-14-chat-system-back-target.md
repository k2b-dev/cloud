### A deferred chat directory had not rendered its Back link yet

- **What happened:** The system-chat unread regression read an undefined Back target even though the URL already named the thread directory (#3342).
- **Root cause:** The test waited 60 ms after clicking Back. It was the first test to render the directory in the CI file, so the import was cold there too. The snapshot and history could finish within that pause while the deferred `ChatThreadsPage` import was still loading. Its Back link renders only after the module arrives; the product supplies the correct target when it does.
- **Error class:** Treating elapsed time or committed URL state as proof that deferred UI has rendered.
- **Guard:** `ChatWorkspace.behavior.test.tsx` observes the rendered directory anchor before independently asserting its `/pwa/chat` target, unread label, count, and navigation. A cold focused run reproduced the original undefined target; the same run passes with the observable wait, with no timeout increase.
