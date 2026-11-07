### Keep attempt recovery across successive registered visits

- **What happened:** During staff-push implementation, starting the next visit made an earlier committed attempt return `404` instead of its reconciliation status.
- **Root cause:** Reconciliation used the device row created for one visit; the next push replaced that row while the registered browser stayed the same.
- **Error class:** Recovery bound to an ephemeral identity.
- **Guard:** `registration.integration.test.ts` checks status-only attempt recovery and terminal command replay after another employee pushes the next visit, while earlier content and attempts from another registered browser remain unavailable.
