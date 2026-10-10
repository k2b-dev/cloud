---
name: cloud-contacts
description: "Use for work involving the user's Cloud address books or contacts: finding or resolving people and organizations, choosing exact contact points, creating or updating records, favorites, tags, moves, and contact notes. Load it whenever a request involves Cloud Contacts, an address book, a contact, or recipient identity."
---

# Work with Cloud Contacts

Use these defaults unless the user asks otherwise or a more specific loaded Skill overrides them.

## Capabilities

- Find: `contacts.contact.search`, `contacts.contact.suggest`, `contacts.contact.resolve`, and `contacts.contact.list`.
- Read: `contacts.contact.read`, `contacts.book.list`, `contacts.book.read`, `contacts.tag.list`, `contacts.tag.read`, `contacts.note.list`, and `contacts.note.read`.
- Maintain: `contacts.contact.create`, `contacts.contact.update`, `contacts.contact.move`, `contacts.contact.delete`, `contacts.favorite.set`, `contacts.tag.change`, and `contacts.note.create`.

Load only the needed capabilities and reuse returned typed IDs unchanged.

## Normal flows

- Use `contacts.contact.search` when no address book is known. Use `contacts.book.list` then `contacts.contact.list` for work inside one known book.
- Use `contacts.contact.suggest` for Mail recipient suggestions. Use `contacts.contact.resolve` only for exact email addresses or contact IDs; never guess which person an ambiguous result represents.
- Read the contact before updating, moving, or deleting it and pass its current `updatedAt` value to conflict-aware mutations.
- Create a contact only after selecting a writable address book. Preserve useful labels and put the primary email, phone, website, or address first.
- Collection fields in `contacts.contact.update` replace the complete collection. Carry forward entries that should remain; use `contacts.tag.change` for a focused tag addition or removal.
- Use contact notes for concise, durable context about that contact. Do not store an email draft or unrelated project notes there.

## Data defaults

- Distinguish people from organizations and preserve names, spelling, labels, preferred language, pronouns, and existing contact points exactly.
- Do not invent an email address, phone number, postal detail, relationship, or company role. Surface ambiguity before a consequential action.
- Avoid duplicate creation when an existing contact may match; search first when the request does not establish that the contact is new.

## Cross-app judgment

- Use Mail when the user wants to communicate with a contact, passing only an exact selected address.
- If the contact is tied to a task, event, or shared work item, consider Spaces.
- If context grows beyond a contact-specific note, consider Notebooks and link the contact when useful.
- Use another app only when it helps the user's request; do not perform an unrelated cross-app mutation.
