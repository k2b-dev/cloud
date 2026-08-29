---
id: ipa-hosts-start
title: Start
icon: ti ti-server
description: FreeIPA host mirror, hostgroups, sync schedule, and admin actions.
order: 100
---

Hosts shows a local mirror of FreeIPA hosts and hostgroups, then lets admins sync the mirror and write selected host or hostgroup changes back to FreeIPA.

## Overview {icon="layout-grid"}

:::reference
- **FreeIPA:** FreeIPA is the source of truth. The page reads from the local mirror and mutations call FreeIPA through the service account.
- **Hostgroup:** A hostgroup groups hosts by FreeIPA membership. Nested hostgroups appear as compact badges in the group header.
- **Ungrouped host:** A mirrored host without any hostgroup membership. The page surfaces them first because they usually need assignment.
- **Sync:** Sync refreshes the local mirror from FreeIPA. The schedule uses a five-field cron expression in the configured timezone.
:::

## Admin workflow {icon="route"}

:::reference
- **Find hosts and groups:** Use the search field to filter hostgroups and hosts. Pagination keeps large mirrors readable.
- **Review assignment gaps:** The Ungrouped stat and section show hosts that are mirrored but not assigned to any hostgroup.
- **Update host metadata:** Use a host row's action menu to edit description, locality, location, MAC addresses, or hostgroup membership.
- **Maintain hostgroups:** Create hostgroups, edit descriptions, or delete obsolete groups from the hostgroup cards.
- **Run or schedule sync:** Use Sync now for an immediate refresh, or Settings to change the recurring sync cron.
:::

:::info CLI and audit trail
The `ipa-hosts` CLI uses the same admin API for list, update, membership, hostgroup, and sync commands. Write actions are audited.
:::
