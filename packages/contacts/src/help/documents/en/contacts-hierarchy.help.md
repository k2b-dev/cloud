---
id: contacts-hierarchy
title: Hierarchy
icon: ti ti-hierarchy
description: Belongs-to links, members, tree view, and hierarchy rules.
order: 110
---

Contact hierarchy links records inside the same book when one contact belongs under another.

## How hierarchy works {icon="route"}

:::reference
- **Belongs to:** The contact editor has an optional parent field. Setting it makes the contact a member of that parent.
- **Members:** A parent contact shows its direct members in the detail panel. You can add a member from the parent contact when you can edit the book.
- **Tree:** The Tree action loads the top-most parent and all descendants for the selected contact, independent of the current page of results.
- **Same book:** Parent and member contacts must live in the same book. Moving a contact removes links that would cross books.
:::

## Rules to remember {icon="book-2"}

:::reference
- **No cycles:** A contact cannot be its own parent, and the server rejects hierarchy cycles.
- **Link only:** Removing a member only removes the parent link. The contact itself stays in the book.
- **Read-only limits:** Contacts can be viewed with read access, but member links can only be changed in writable books.
:::

:::success Use hierarchy sparingly
Use hierarchy for durable membership. Use tags for loose categories that can overlap.
:::
