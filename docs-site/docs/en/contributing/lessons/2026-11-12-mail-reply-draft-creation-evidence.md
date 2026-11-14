### Preserve draft text supplied at creation during consolidation

- **What happened:** F6 could erase an older reply draft with real text in favor of a newer untouched duplicate.
- **Root cause:** Revision and edit timestamps omitted text supplied at creation: legacy drafts could have real content at revision 1 with no edit timestamp. Matching signatures against current templates and leaving blank lines before German quotes also misclassified untouched legacy bodies as edits.
- **Error class:** Destructive migration ranking based on incomplete content evidence.
- **Guard:** `packages/mail/src/service/reply-draft-body-evidence.test.ts` covers historical English/German signature and quote layouts without infrastructure, including signatures whose templates changed, were archived or belonged to a service account. `packages/mail/src/service/one-reply-draft.integration.test.ts` covers revision-1 text against newer untouched replies, signature-only bodies and two untouched duplicates, with separate source quotes and embedded reply or forward history.
