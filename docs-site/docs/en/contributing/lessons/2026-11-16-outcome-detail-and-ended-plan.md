### An outcome ran into its detail, and an ended plan kept running

- **What happened:** In the sixth Preview tour an expired approval read "Nicht ausgeführt: Notiz in Logistik-Handbuch erstellen Die Frage ist abgelaufen." without a full stop between the two sentences, and the task list above the field still showed its current step as running after the answer had broken off.
- **Root cause:** Short outcome forms such as "Nicht ausgeführt: …" end without a full stop, and `Chat.Outcome` joins a line and its detail with a space. The Assistant handed the plan to `Chat.Tasks` as stored, so a step left `in_progress` by an ended turn stayed the current one.
- **Error class:** A state carried past the end of the work that set it; two texts joined without the separator one of them lacks.
- **Guard:** `ActionReceipt` closes the sentence before a detail (`approval.behavior.test.tsx`); `shownTasks` shows a step as current only while a turn still works on the plan (`task-host.test.ts`).
