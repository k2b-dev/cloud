---
name: cloud-cli
description: Use the Cloud CLI (`cld`) to work with a user's Cloud content from a terminal. Use this skill whenever an agent needs to use installed Cloud app commands, sign in or select a Cloud profile, choose safe CLI input/output, inspect Cloud API documentation, or complete Assistant, Contacts, FAQ, Grids, Kit, Mail, Notebooks, Pulse, Spaces, or Tools workflows for the user.
---

# Cloud CLI

Cloud is a remote workspace platform, or Cloud OS, made of focused apps for work and daily operations. Each Cloud instance can publish a different set of apps to each user.

Use `cld` to work with the user's Cloud content from a terminal. It handles sign-in, the selected Cloud instance, command discovery, and structured output.

## Start

1. On a new machine, sign in with `cld login --server <Cloud URL>`. Inspect or switch profiles with `cld profile list` and `cld profile use <name>`.
2. Run `cld apps list --json` before choosing an app command. It shows the live Cloud apps available to the current user; use `--search <text>` to narrow the list.
3. Run `cld help` to discover installed CLI modules, then `cld <app> help` or `cld <app> <command> --help` for an unfamiliar operation.
4. Use the default profile unless the task names another instance; pass `--profile <name>` only when needed.

## Agent workflow

- Stay on the user's selected profile unless they name another Cloud instance.
- Read before changing content. Use IDs returned by list or get commands when a name is not unique.
- Use `--json` whenever the next action depends on one complete response. Use `--jsonl` for supported list commands when processing items as a stream. Keep normal output for simple inspection.
- Pass structured or multiline content through a command's file or stdin option instead of trying to escape it in a shell argument.
- Do not delete content, revoke access, or perform another destructive action without an explicit user request. Check command help for any required confirmation first.

## References

Read the app reference for the current task. Follow specialized links inside it only when that operation needs the deeper API; do not preload every linked reference.

- Read [Account](references/account.md) to manage the signed-in user's profile, personal API keys, SSH keys, and account extension.
- Read [API Docs](references/api-docs.md) to discover and inspect the live HTTP APIs published by Cloud apps.
- Read [Capabilities](references/capabilities.md) to discover and invoke live typed app Queries and Actions through the generic CLI.
- Read [Assistant](references/assistant.md) for one-shot streaming chat, chat history, approvals, files, personalization, and Projects.
- Read [Contacts](references/contacts.md) for contact books, contacts, tags, notes, exports, and access grants.
- Read [FAQ](references/faq.md) to list and manage localized, audience-aware FAQ entries as an administrator.
- Read [Grids](references/grids.md) to create bases from templates and manage schema, records, GQL, views, forms, Custom Apps, documents, access, and workflows.
- For a complete Grids business application, also read [Build a business application](references/grids-build-apps.md): inventory, CRM, invoicing, expense reimbursement, and merchandise-management model choices and verification.
- Read [Kit](references/kit.md) to create, validate, edit and share local browser tools.
- Read [Mail](references/mail.md) to configure and share mailboxes, search and collaborate on conversations, then follow its compose, automation, and operations references for the complete Mail CLI.
- Read [Notebooks](references/notebooks.md) for collaborative notes, knowledge search, safe Markdown editing, query and TOC preview validation, comments, notebook views, attachments, formulas, exports, and access.
- Read [Pulse](references/pulse.md) to explore telemetry and observed fields, ingest structured events, run queries, create DSL dashboards, manage sources, and share public displays.
- Read [Spaces](references/spaces.md) for spaces, items, comments, calendars, and access grants.
- Read [Tools](references/tools.md) for local password, encoding, QR, encryption, and speedtest utilities.
- Read [Venue](references/venue.md) to operate venues, opening rules, public sections, shifts, and venue access.

Administrators should additionally read the reference that matches the task:

- [Accounts](references/accounts.md) for accounts, groups, requests, audit events, and service-account credentials.
- [Administration](references/admin.md) for health, diagnostics, logs, request telemetry, background jobs, workflow runs, notifications, announcements, webhooks, storage diagnostics, and metrics.
- [OAuth](references/oauth.md) for OAuth client configuration.
- [IPA hosts](references/ipa-hosts.md) for FreeIPA hosts, hostgroups, and host synchronization.
