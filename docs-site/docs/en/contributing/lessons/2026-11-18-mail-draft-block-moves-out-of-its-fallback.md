### Maximizing a compose window must not replace a node that already moved

- **What happened:** Maximizing a new message window raised `HierarchyRequestError: Failed to execute 'replaceChild' on 'Node': The new child element contains the parent.`
- **Root cause:** `MailComposer.tsx` passed one prebuilt element, the draft block, both as the `Show` fallback and to the large layout. Turning large, Solid first rendered the large layout, which moved the block into its pane, and then replaced the fallback through the block's new parent, which lay inside the large layout itself.
- **Error class:** One JSX element used in two render places of a `Show`.
- **Guard:** The mail-shell drafts browser case "Maximize turns a new message window large and back with the same text, without a page error (#3683)" fails on any page error. Before it, only the optional screenshot run maximized a window. Convention: a moving element gets a wrapper of its own in its fallback place.
