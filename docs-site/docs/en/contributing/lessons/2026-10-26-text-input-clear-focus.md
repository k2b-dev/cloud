---
title: Restore field focus before a clear control disappears
navTitle: TextInput clear focus
section: Contributing
order: 1610
description: Keep keyboard focus usable when clearing a shared text input.
tags: [contributing, testing]
updated: 2026-10-26
---

# Restore field focus before a clear control disappears

- **Class:** Clearing a text field could leave keyboard focus on the page.
- **What goes wrong:** The focused clear button disappears with the value, without moving focus back into the field.
- **Guard:** Browser tests clear a field by keyboard and type again, and verify that a caller can deliberately move focus in its clear callback.
- **Evidence:** Focus the input before invoking the callback, while the clear button still exists.
