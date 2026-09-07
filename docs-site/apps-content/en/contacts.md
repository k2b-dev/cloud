---
title: Contacts
navTitle: Contacts
section: Work
order: 105
description: Shared contact books with structured records, tags, notes, hierarchy, and access control.
tags: [contacts, address-books, cli]
updated: 2026-09-07
---

# Contacts

Contacts manages shared address books for people, organizations, suppliers,
customers, and other parties. Records can contain structured contact points,
addresses, work and personal data, notes, tags, and hierarchy links.

## Use Contacts

- Search across readable manual books when you know the person but not the
  owning book.
- Keep customer, supplier, team, or project contacts in separate books with
  their own access rules.
- Store emails, phone numbers, addresses, work data, personal data, and bank
  details as structured fields.
- Use tags for overlapping categories and notes for contact-specific context.
- Link members to a parent contact when the relationship is a durable
  hierarchy rather than a loose category.

The read-only system book projects contacts from the IPA directory. Manual
books contain records created and maintained by Cloud users.

## Understand the Contacts model

| Resource | Responsibility |
| --- | --- |
| Contact book | Permission-scoped collection of manual contacts and book-specific tags |
| Contact | Structured record for a person, organization, or other party |
| Note and tag | Book-owned context for collaboration and filtering |
| Hierarchy | Parent and member links between contacts in the same manual book |
| System book | Read-only projection of contacts from the IPA directory |

Tags and hierarchy links stay within one manual book. Moving a contact to
another book removes relationships that cannot cross that boundary.

## How Contacts fits Cloud

Contacts owns records, hierarchy, import, export, and its application API.
Cloud supplies identity and principals, resource access, resource-bound API
keys, live application discovery, and shared Help and administration surfaces.

## Find detailed product help

Open **Help** inside Contacts for books, records, tags, hierarchy, import,
export, and access management. Developers can read
[Resource authorization](/en/docs/identity/authorization),
[Resource API keys](/en/docs/identity/resource-api-keys), and
[App capabilities](/en/docs/platform/capabilities) for the shared contracts
Contacts adopts.

## Automate Contacts from the terminal

Contacts provides a native CLI module for scripts and terminal workflows. Start
with read commands and use stable IDs from JSON output when names are
ambiguous:

```bash
cld contacts books --json
cld contacts search "Ada Lovelace" --json
```

Run `cld contacts help` for the available areas. Run
`cld contacts <command> --help` before a mutation or destructive operation to
read its current fields and confirmation requirements.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.
