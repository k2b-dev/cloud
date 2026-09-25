---
name: cloud-cli
description: Use the Cloud CLI (`cld`) to work with a user's Cloud content from a terminal. Use this skill whenever an agent needs to use installed Cloud app commands, sign in or select a Cloud profile, choose safe CLI input/output, inspect Cloud API documentation, or complete Assistant, Contacts, FAQ, Files, Grids, Mail, Notebooks, Pulse, Spaces, or Tools workflows for the user.
---

# Cloud CLI

Cloud is a remote workspace platform, or Cloud OS, made of focused apps for work and daily operations. Each Cloud instance can publish a different set of apps to each user.

Use `cld` to work with the user's Cloud content from a terminal. It handles sign-in, the selected Cloud instance, command discovery, and structured output.

## Start

1. On a new machine, sign in with `cld login --server <Cloud URL>`. On a machine without a browser, such as a server reached over SSH, use `cld login --server <Cloud URL> --device`. Inspect or switch profiles with `cld profile list` and `cld profile use <name>`. Read [Sign-in and profiles](references/sign-in.md) for details.
2. Run `cld apps list --json` before choosing an app command. It shows the live Cloud apps available to the current user; use `--search <text>` to narrow the list.
3. Run `cld help` to discover installed CLI modules, then `cld <app> help` or `cld <app> <command> --help` for an unfamiliar operation. Modules of third-party apps come from `cld` plugins; `cld plugins list` shows which are installed and whether they load.
4. Use the default profile unless the task names another instance; pass `--profile <name>` only when needed.

## Agent workflow

- Stay on the user's selected profile unless they name another Cloud instance.
- When you operate a headless box (SSH, container, CI runner) and `cld` is not signed in, run `cld login --server <Cloud URL> --device` and relay the printed URL and code to the user; they approve it in their own browser. Never ask the user for a password or token instead.
- Read before changing content. Use IDs returned by list or get commands when a name is not unique.
- Use `--json` whenever the next action depends on one complete response. Use `--jsonl` for supported list commands when processing items as a stream. Keep normal output for simple inspection.
- Pass structured or multiline content through a command's file or stdin option instead of trying to escape it in a shell argument.
- Do not delete content, revoke access, or perform another destructive action without an explicit user request. Check command help for any required confirmation first.
- Install or remove a `cld` plugin only when the user asks for that exact package or path. A plugin runs unsandboxed with the user's Cloud credentials; confirm the package, version, and source shown by `cld plugins install` before you pass `--yes`.

## References

Read the app reference for the current task. Follow specialized links inside it only when that operation needs the deeper API; do not preload every linked reference.

- Read [Sign-in and profiles](references/sign-in.md) to sign in with a browser or a device code, keep several Cloud instances in profiles, and store refresh tokens in fd0.
- Read [Account](references/account.md) to manage the signed-in user's profile, personal API keys, SSH keys, and account extension.
- Read [API Docs](references/api-docs.md) to discover and inspect the live HTTP APIs published by Cloud apps.
- Read [CLI plugins](references/plugins.md) to list, install, or remove `cld` plugins that add third-party app commands.
- Read [Capabilities](references/capabilities.md) to discover and invoke live typed app Queries and Actions through the generic CLI.
- Read [Assistant](references/assistant.md) for one-shot streaming chat, chat history, approvals, files, personalization, and Projects.
- Read [Contacts](references/contacts.md) for contact books, contacts, tags, notes, exports, and access grants.
- Read [FAQ](references/faq.md) to list and manage localized, audience-aware FAQ entries as an administrator.
- Read [Files](references/filesv2.md) (`cld filesv2`) to browse Cloud and FreeIPA storage, download files directly, and administer directory provisioning, archives, permanent deletion, root maintenance, and storage configuration.
- Read [Grids](references/grids.md) to create bases from templates and manage schema, records, GQL, views, forms, Custom Apps, documents, access, and workflows.
- For a complete Grids business application, also read [Build a business application](references/grids-build-apps.md): inventory, CRM, invoicing, expense reimbursement, and merchandise-management model choices and verification.
- For Grids configuration, read [Schema and records](references/grids-schema.md): table options, every field type, ID assignment, formats, Views, Forms and finalization. For files and financial exports, read [Documents and exports](references/grids-documents.md): templates, Liquid, profiles, SEPA, DATEV, membership and download links. The main Grids reference routes Custom App and Workflow configuration to their complete machine-readable schemas.
- Read [Mail](references/mail.md) to configure and share mailboxes, search and collaborate on conversations, then follow its compose, automation, and operations references for the complete Mail CLI.
- Read [Notebooks](references/notebooks.md) for collaborative notes addressed by ID or `<notebook>:<path>`, a notebook as a local folder of Markdown files (`pull`, migrating a Git docs folder), knowledge search, safe Markdown editing, query and TOC preview validation, comments, attachments, formulas, exports, and access.
- Read [Pulse](references/pulse.md) to explore telemetry and observed fields, ingest structured events, run queries, create DSL dashboards, manage sources, and share public displays.
- Read [Spaces](references/spaces.md) for spaces, items, comments, calendars, and access grants.
- Read [Tools](references/tools.md) for local password, encoding, QR, encryption, and speedtest utilities.
- Read [Venue](references/venue.md) to operate venues, opening rules, public sections, shifts, and venue access.

Administrators should additionally read the reference that matches the task:

- [Accounts](references/accounts.md) for accounts, groups, requests, audit events, and service-account credentials.
- [Administration](references/admin.md) for AI model prices, reference-cost reports, Assistant budgets and resets, background emergency stops, health, diagnostics, logs, request telemetry, background jobs, workflow runs, notifications, announcements, webhooks, storage diagnostics, and metrics.
- [OAuth](references/oauth.md) for OAuth client configuration.
- [IPA hosts](references/ipa-hosts.md) for FreeIPA hosts, hostgroups, and host synchronization.
