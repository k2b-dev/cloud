### Link to the card's DOM anchor

- **What happened:** Code waiting items and decision events could point at a tool-call anchor instead of the version card.
- **Root cause:** Navigation reused submission provenance even though the card owns a separate `code-version-<versionId>` DOM anchor.
- **Error class:** Navigation data and rendered target disagree.
- **Guard:** The delivery integration compares waiting and decision targets; a render test compares the shared target resolver with the card's ApprovalFrame DOM attribute. Renewing an expired review preserves the first card's canonical anchor.
