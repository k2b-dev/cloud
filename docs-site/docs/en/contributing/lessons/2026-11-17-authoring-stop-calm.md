### A paused authoring turn overstated costs and blurred drafts with versions

- **What happened:** Gustav's stop card said further attempts would cost too much and called a draft saved while saving a version remained open.
- **Root cause:** App messages interpreted the input-token allocation as a cost decision and used the same saving language for working drafts and submitted versions.
- **Error class:** Misleading status presentation across distinct persistence stages.
- **Guard:** `AssistantAuthoringStop.render.test.ts` covers every stop reason in German and English across absent, open, submitted, and mixed drafts, checking the title, reason, saved state, and checklist without cost claims.
