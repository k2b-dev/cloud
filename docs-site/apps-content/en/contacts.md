---
title: Contacts
navTitle: Contacts
section: Work
order: 105
description: Shared contact books with structured records, tags, notes, hierarchy, and access control.
tags: [contacts, address-books, cli]
updated: 2026-09-26
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

The `cld contacts` CLI finds and changes contacts from scripts and terminal
workflows. A command that takes a contact accepts a **contact ID** such as
`Ab12Cd`, or **`<book>:<name>`** such as `"Customers:Ada Lovelace"`, where the
book is an ID or exact name and the name is the contact's exact display name.
`show --email <address>` finds the one readable contact with that email
address. Book names and display names are not unique: when a name or email
matches several resources, the command fails and lists every candidate with
its path and ID instead of guessing.

```bash
cld contacts ls
cld contacts ls Customers --q ada --tag VIP --json
cld contacts show --email ada@example.org --json
cld contacts add "Customers:Ada Lovelace" --email work=ada@example.org
cld contacts set "Customers:Ada Lovelace" --job-title Mathematician
cld contacts mv "Customers:Ada Lovelace" Alumni
cld contacts import Customers --from contacts.vcf --dry-run
```

Books, tags, notes, and access grants are command groups: `books add`,
`tags list`, `notes add`, `access grant`. `rm` and the other delete commands
ask for confirmation in a terminal and need `--yes` in scripts. Every command
prints a stable JSON shape with `--json`.

Run `cld contacts help` for the full command set and
`cld contacts <command> --help` before a mutation or destructive operation.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.


## Compose from global search

An open contact with an email address contributes **Compose email to NAME**
to the global search, including app-scoped searches. Selecting it opens Mail
with a permission-checked recipient. Multiple addresses prompt a choice.

## Actions in Cloud search

Use **New contact** in Cloud search to open the contact form and choose a writable address book. Within an address book, it is used as the destination. The selected contact exposes editing, moving to another writable book, and composing an email when an address is available.

Available keyboard shortcuts appear next to actions and in Layout Help.

Cmd/Ctrl+Shift+K searches all accessible contacts. Cmd/Ctrl+Alt+N creates a contact in the current writable book, or asks for a book. E edits the selected contact outside input fields. Search actions update the open palette in place. Actions for the selected object appear before page actions.
