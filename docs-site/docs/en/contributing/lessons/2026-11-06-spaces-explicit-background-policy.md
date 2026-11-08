### Resource permission alone did not admit safe background Actions

- **What happened:** Background callers could not create plain Space items or link a resource despite having Space write access.
- **Root cause:** The Actions declared only legacy rememberable approval; background admission requires an explicit silent policy and a review without a per-call asking reason.
- **Error class:** Missing explicit policy at a machine composition boundary.
- **Guard:** Spaces capability tests assert the explicit policies, per-call asking reasons for templates and assignees, localized complete reviews, and refusal without write access.
