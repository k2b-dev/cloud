---
title: Files history contact checks
navTitle: Files history contact checks
section: Contributing
order: 1605
description: Compare retained local Cloud evidence when an item is contacted.
tags: [contributing, testing]
updated: 2026-10-25
---

# Files history contact checks

## External change missed on contact

- **Class:** Missing contact wiring and incorrect ordering of a definite refusal and its follow-up comparison.
- **What goes wrong:** Targeted history reads skip comparison with current storage, or a refused write still suppresses observation of another writer.
- **Guard:** Files `service/activity-observations.integration.test.ts` exercises local Cloud item and missing-path history contacts, deduplication, and a real Filegate Office write race that must return 412, settle the failed activity, and record the external difference. POSIX contacts return `history_unavailable` without recording observations.
- **Evidence:** The focused tests named above.
