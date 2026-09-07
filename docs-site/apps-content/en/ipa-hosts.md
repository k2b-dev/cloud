---
title: Hosts
navTitle: Hosts
section: Operations
order: 410
description: Administer FreeIPA hosts, hostgroups, mirrored membership, and synchronization.
tags: [freeipa, hosts, hostgroups, operations]
updated: 2026-09-07
---

# Hosts

Hosts presents a local mirror of FreeIPA hosts and hostgroups. Administrators
can review directory membership, write selected changes back to FreeIPA, and
synchronize the mirror on demand or on a schedule.

## Use Hosts

- Find a host or hostgroup without browsing the directory manually.
- Review mirrored hosts that do not belong to any hostgroup.
- Update host metadata such as description, locality, location, or MAC
  addresses.
- Add or remove hostgroup membership and maintain hostgroup descriptions.
- Run a synchronization or change its recurring cron schedule.

FreeIPA remains the source of truth. If a record is missing or a value reverts,
first determine whether the directory write failed or the local mirror needs a
successful synchronization.

## Understand the Hosts model

| Resource | Responsibility |
| --- | --- |
| Host | Mirrored FreeIPA machine record and editable directory metadata |
| Hostgroup | FreeIPA group containing hosts and optional nested hostgroups |
| Membership | Directory relationship between a host and a hostgroup |
| Local mirror | Read model used by the Hosts interface and searches |
| Sync schedule | Five-field cron expression controlling recurring mirror refreshes |

An ungrouped host is a mirrored host with no hostgroup membership. The app
surfaces these records because they usually need an administrator decision.

## How Hosts fits Cloud

Hosts owns the mirrored read model, admin UI, CLI module, synchronization job,
and FreeIPA adapter. FreeIPA owns the authoritative host and hostgroup records.
Cloud supplies administrator identity, settings, scheduled work, widgets, API
publication, and audit events for write actions.

## Find detailed product help

Open **Help** inside Hosts for search, host and hostgroup maintenance,
synchronization, and recovery from stale or rejected directory changes.
Developers can read [FreeIPA operations](/en/docs/operations/freeipa),
[Audit events](/en/docs/platform/audit-events), and
[Application settings](/en/docs/platform/settings) for the shared contracts
the app adopts.

## Inspect Hosts from the terminal

The native module uses the same administrator API as the web interface. Start
with read commands before changing directory state:

```bash
cld ipa-hosts hosts list --json
cld ipa-hosts groups list --json
```

Run `cld ipa-hosts help` for the available areas. Run
`cld ipa-hosts <area> <command> --help` before a write, membership change, or
sync action; mutations require the same administrator access and confirmation
rules as the supported CLI command.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.
