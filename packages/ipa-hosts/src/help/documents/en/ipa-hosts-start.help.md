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
- **FreeIPA:** FreeIPA is the source of truth. The page reads from the local mirror and mutations call FreeIPA as the FreeIPA user from the sign-in settings.
- **Hostgroup:** A hostgroup groups hosts by FreeIPA membership. An open hostgroup names its nested groups, its hosts and how many of them have no SSH keys.
- **Ungrouped host:** A mirrored host without any hostgroup membership. The top of the page says how many there are; the Ungrouped tab lists them.
- **Sync:** Sync refreshes the local mirror from FreeIPA. The schedule uses a five-field cron expression in the configured timezone.
:::

## Admin workflow {icon="route"}

:::reference
- **Find hosts and groups:** Use the search field to filter hostgroups and hosts. Pagination keeps large mirrors readable.
- **Review assignment gaps:** The figure at the top and the Ungrouped tab show mirrored hosts without a hostgroup. The line below it names hosts without SSH keys.
- **Update host metadata:** Open the host in the list. Edit changes its description, locality, location and MAC addresses; under Hostgroups, Add to hostgroup adds it to a group and Remove takes it out.
- **Maintain hostgroups:** Create a group with New hostgroup. Open a group in the list to edit its description or to delete it under More actions.
- **Run or schedule sync:** Under More actions in the head, Sync now starts an immediate refresh and Host sync settings changes the recurring sync cron.
:::

:::info CLI and audit trail
The `ipa-hosts` CLI uses the same admin API for list, update, membership, hostgroup, and sync commands. Write actions are audited.
:::
