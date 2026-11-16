### Keep empty group seeds empty

- **What happened:** Some group-free access changes omitted person identity hints.
- **Root cause:** A null group field produced a recursive seed row, disabling the existing empty-seed fallback.
- **Error class:** Treating a null-valued seed as an affected entity.
- **Guard:** The room-access outbox integration suite checks restriction and removal for both kinds of group-free grants, including ordinary people and guests.
