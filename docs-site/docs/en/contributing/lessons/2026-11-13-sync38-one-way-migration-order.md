### Two one-way migrations in one start keep a recovery image for each refusal

- **What happened:** Merging Mail v5 into the Code branch put its one-time reply-draft consolidation (F6) behind the Mail rule retirement in one start. Both claimed schema marker 4 at first, and the retirement committed its marker before F6 could refuse. A refused F6 then left a database that no previous Mail image would start.
- **Root cause:** Each branch ordered its own one-way migration correctly, but the merge decided their relative order and marker numbers without checking each refusal path against the images that must still start.
- **Error class:** Independent irreversible migrations combined in one startup lose their documented recovery path.
- **Guard:** Released numbers win (F6 keeps 4, the retirement moves to 5, earlier Code-branch markers are renamed before F6 reads 4). F6 runs before the retirement, which is the 0.74 → 0.75 → Code order. `packages/mail/src/migrate-order.integration.test.ts` covers a fresh install, 0.74, 0.75, an earlier Code-branch database and a refused retirement; the F6 refusal tests in `one-reply-draft.integration.test.ts` keep asserting the 0.74-compatible history.
