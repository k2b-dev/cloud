---
id: contacts-hierarchy
title: Hierarchy
icon: ti ti-hierarchy
description: Link a contact under a parent, add members, open the tree, and follow the hierarchy rules.
order: 110
---

Contact hierarchy links records inside the same book when one contact belongs under another.

## Link contacts {icon="route"}

:::reference
- **Belongs to:** An optional parent field in the contact editor. When you set it, the contact becomes a member of that parent.
- **Members:** A parent contact shows its direct members in the detail panel. With **Edit** or **Manage** access to the book, you can add a member there.
- **Tree:** Loads the top-most parent and all descendants of the selected contact, independent of the current page of results.
- **Same book:** A parent and its members must be in the same book. Moving a contact removes the links that would cross books.
:::

## Follow the rules {icon="book-2"}

:::reference
- **No cycles:** A contact cannot be its own parent. The server also rejects cycles in the hierarchy.
- **Link only:** Removing a member removes only its parent link. The contact itself stays in the book.
- **View access:** With **View** access, you can see contacts. To change member links, you need **Edit** or **Manage** access to the book.
:::

:::success Use hierarchy sparingly
Use the hierarchy for lasting membership. Use tags for loose categories that can overlap.
:::
