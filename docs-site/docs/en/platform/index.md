---
title: Platform services
navTitle: Overview
section: Platform services
order: 500
description: Choose the platform boundary that removes shared infrastructure from an application.
tags: [platform, api, applications]
updated: 2026-10-06
---

# Platform services

Platform services keep cross-cutting infrastructure out of independently
deployed applications. Your application contributes the domain-specific
contract; Cloud runs the shared infrastructure and presents one consistent
surface to users, agents, and operators.

Use a platform service when the behavior must integrate with the wider Cloud
installation. Keep behavior in the application when it is meaningful only to
that domain. These services are runtime boundaries, not code generators: they
do not copy files into an application or take ownership of its data model.

## Choose a service

| Need | Application contributes | Cloud provides |
| --- | --- | --- |
| Runtime configuration | Typed setting declarations and defaults | Validation, encrypted persistence, caching, and request snapshots |
| Operational events | A source, message, and structured metadata | Console output, redaction, persistence, retention, and operations views |
| One operation across boundaries | Span names, events, and safe attributes | Trace storage, timing, status, and operations views |
| Security evidence | An action, outcome, actor, and target | Durable, sanitized audit storage |
| User communication | Typed payloads and channel-neutral presentation | Preferences, channel routing, durable delivery, retries, and deduplication |
| Cross-app and agent operations | Curated Types, Queries, and Actions | Live schemas, generic dispatch, CLI, and MCP tools |
| Files for other apps | A list Query, a read stream, and optionally a save Action | The shared file-provider contract, its checks, and discovery in the capability catalog |
| Global discovery | One permission-aware Query projected into Universal Search | Provider discovery, query fan-out, and shared search UI |
| Dashboard summaries | Authenticated JSON endpoints | Widget discovery, layout, and rendering |
| Product guidance | Markdown help documents | Search, rendering, and the shared Help surface |
| Documents | HTML or Liquid templates and data | Shared Gotenberg configuration and PDF limits |
| Document extraction | Authorized document bytes | Bounded untrusted Markdown without storage or authorization |
| Command-line operations | A typed CLI module | Authentication, profiles, output modes, and dispatch |

Start from the need in this table, then open the linked page in the navigation
for its complete declaration, lifecycle, failure, and verification contract. Use
[Building blocks](/en/docs/building-blocks) when you know the task but not the
service, or [API surface](/en/docs/reference/api-surface) to look up an import.

Request middleware and identity are separate application boundaries:
[Request middleware](/en/docs/server/middleware) loads request context, while
[Identity and access](/en/docs/identity) explains caller and resource checks.
