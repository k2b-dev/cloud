### The sidebar said nothing waits while the row above the field listed two entries

- **What happened:** The Assistant sidebar showed "Waiting for you 0" while the "Waiting for you" row above the field listed two entries, such as "Switch on version 2".
- **Root cause:** The sidebar counted the platform's approval requests for the Assistant, while the row lists the person's open questions, which also hold Code entries that are not approval requests. The two numbers came from different sources.
- **Error class:** A count and the list it stands for are read from different sources, so they agree only while both happen to contain the same kinds.
- **Guard:** The sidebar takes its count from the same view as the row. `packages/assistant/src/frontend/AssistantWorkspace.waiting.behavior.test.tsx` mounts the workspace with Code entries and no approval and checks that both numbers match, also after live changes.
