### Preserve block semantics when rendering Action reviews

- **What happened:** The capability runner flattened review blocks into text. Named draft recipients lost their email addresses. Editable approval drafts also rendered with `readonly="false"` on the server, which HTML treats as read-only.
- **Root cause:** The runner used the text projection instead of the shared `ActionDetails` and `BlockTree` renderer. The context renderer chose a name over its address. The draft renderer passed a false `readOnly` value through a component spread that serialized it as an attribute.
- **Error class:** Losing presentation semantics at a shared rendering boundary.
- **Guard:** `packages/capabilities/src/action-review.test.tsx` asserts rendered draft blocks and consequences. `packages/mail/src/capability-reviews.render.test.tsx` requires every recipient address to survive rendering. `packages/cloud/src/ai/chat/action-question.render.test.tsx` parses server HTML and checks that editable fields have no `readonly` attribute and approval fields remain read-only.
