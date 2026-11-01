### Mail's own provider draft copy came back as an outside edit

- **What happened:** While someone typed in a fresh Mail composer, the header showed "Der aktuelle Stand hat sich geändert. Lade die Daten neu und versuche es erneut." The next autosave failed with a conflict although nobody else had edited the draft.
- **Root cause:** Draft export wrote the body as the text part unchanged, and draft import removes one transport line ending from every provider copy. A body that ended in a line break, as it does after Enter at the end of the text, came back one character shorter. Its fingerprint no longer matched Mail's own copy, so the Drafts sync imported it as an outside edit and raised the revision under the composer.
- **Error class:** An export and an import of the same data apply different normalizations, so a round trip changes the data and an own write looks like a foreign one.
- **Guard:** `packages/mail/src/service/draft-provider-mime.test.ts` ("returns body … unchanged through Cloud's own provider copy") and `packages/mail/src/service/sent-projection.integration.test.ts` ("a draft whose text ends in a line break keeps its revision when the sync sees Mail's own copy").
