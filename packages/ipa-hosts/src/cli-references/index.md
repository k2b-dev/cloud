# IPA Hosts CLI

## What IPA Hosts is

IPA Hosts mirrors FreeIPA hosts and hostgroups so administrators can inspect them, manage selected host data, and schedule synchronization with FreeIPA.

Use `cld ipa-hosts` to manage FreeIPA hosts, hostgroups, and the Cloud-managed host synchronization schedule.

## Inspect hosts and hostgroups

```bash
cld ipa-hosts hosts list --search "lab" --json
cld ipa-hosts hosts get workstation.example.org --json
cld ipa-hosts groups list --search "lab" --json
cld ipa-hosts groups search "workstations" --json
```

Use fully qualified host names for host operations. List or search hostgroups before changing a membership.

## Update host membership and metadata

```bash
cld ipa-hosts hosts update workstation.example.org --location "Office" --mac-address 00:11:22:33:44:55
cld ipa-hosts hosts add-group workstation.example.org workstations
cld ipa-hosts hosts remove-group workstation.example.org workstations --yes
cld ipa-hosts groups create --name workstations --description "Managed workstations"
```

Hostgroup removal and deleting a host or hostgroup require `--yes`. Inspect the host and its existing hostgroups first, especially before removing access-related memberships.

## Synchronization

```bash
cld ipa-hosts sync status --json
cld ipa-hosts sync schedule --cron "0 * * * *"
cld ipa-hosts sync run --yes
```

Changing the schedule changes when FreeIPA host data is synchronized. Trigger a manual run only when the user requested it or after confirming the schedule and expected impact.

## Complete command catalogue

Run `cld ipa-hosts <command> --help` for flags and argument order.

| Area | Commands |
| --- | --- |
| Hosts | `hosts list`, `hosts get`, `hosts update`, `hosts delete`, `hosts add-group`, `hosts remove-group` |
| Hostgroups | `groups list`, `groups search`, `groups create`, `groups update`, `groups delete` |
| Synchronization | `sync status`, `sync schedule`, `sync run` |
