---
id: ipa-hosts-troubleshooting
title: Troubleshooting
icon: ti ti-lifebuoy
description: Resolve stale mirrors, missing hosts, invalid metadata, membership problems, and sync failures.
order: 110
---

Hosts displays a local mirror while FreeIPA remains the source of truth. When the UI and directory differ, determine whether the write failed or the mirror simply needs a successful sync.

## Common symptoms {icon="lifebuoy"}

:::reference
- **A host or hostgroup is missing:** Clear search, check pagination, then run Sync now if the directory changed recently.
- **A recently edited value reverted:** Another FreeIPA write or a later sync may have replaced it. Check the audited action and current directory value.
- **A host stays ungrouped:** Open the host action menu and add at least one hostgroup, then confirm the next sync completes.
- **A MAC address is rejected:** Use the expected hexadecimal address format and remove duplicates.
- **A hostgroup cannot be deleted:** Remove or move memberships that still depend on the group, then retry only when the directory allows deletion.
- **Scheduled sync does not run:** Check the five-field cron expression, configured timezone, service credentials, and the most recent sync error.
:::

## Safe recovery path {icon="lifebuoy"}

:::steps
1. Save the exact host or hostgroup name and the time of the failed action.
2. Refresh once to rule out a stale page.
3. Run a manual sync when the FreeIPA source is known to be correct.
4. Retry one narrow write.
5. Use the audit trail or CLI output when the same action fails again.
:::

:::warning Source of truth
Do not repeatedly recreate missing mirrored records. Correct the FreeIPA record or connectivity problem, then synchronize the mirror.
:::
