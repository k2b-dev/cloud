# Contacts CLI

## What Contacts is

Contacts manages address books with structured contact records, tags, notes, hierarchy links, and book-level access.

Use `cld contacts` to find, create, change, move, and delete contacts, and to manage contact books, tags, notes, vCard import and export, and access grants. It requires a signed-in Cloud profile.

## Core model

- A **contact book** is the access boundary. Its `id` is a stable six-character ID. Book names are not unique.
- A **contact** lives in exactly one book. Its `id` is a stable six-character ID, unique across all books. Its display name is the label, else the full name, else the company, else the first email or phone. Display names are not unique.
- **Tags** and **hierarchy links** (parent contact) stay inside one book. Moving a contact to another book removes them.
- A **note** is a short comment on a contact. Only its author can change or delete it, and only for 10 minutes.

## Address contacts

Every command that takes a `<contact>` accepts two forms:

1. **Contact ID**, such as `Ab12Cd`. It always resolves and needs no book.
2. **`<book>:<name>`**, such as `"Customers:Ada Lovelace"`. The book is its ID or exact name; the name is the contact's exact display name or its ID. The argument is split at the first colon, so names may contain colons.

A book-scoped command (`ls`, `export`, `import`, `books update|delete`, `tags list`, `access`) takes `<book>` as ID or exact name. `<book>:` with an empty name addresses the book itself, for example `cld contacts show Customers:`. Tags are addressed as `<book>:<tag>`, the tag by ID or exact name.

To find the contact behind an email address, use `cld contacts show --email ada@example.org`. The match is exact and case-insensitive across all readable books.

When a book name, display name, or email address matches more than one resource, the command fails with exit code 1 and lists every candidate with its path and ID, for example `"Ada Lovelace" matches several contacts: Customers:Ada Lovelace (Ab12Cd), Customers:Ada Lovelace (Ef34Gh). Use one of these paths or IDs.` It never guesses. Retry with one of the listed IDs.

## Read before changing

```bash
cld contacts ls --json
cld contacts ls "Customers" --q ada --tag VIP --json
cld contacts show "Customers:Ada Lovelace" --json
cld contacts show --email ada@example.org --json
cld contacts search "Ada Lovelace" --json
cld contacts tree Ab12Cd
```

`ls` without a book lists the books you can read; `--q` filters them by name. With a book it lists its contacts; `--q` searches them and repeated `--tag` keeps contacts with any of the tags. `search` spans all readable books. Continue with `--page` while `pagination.has_next` is true.

## Create and change

```bash
cld contacts add "Customers:Ada Lovelace" --email work=ada@example.org --tag VIP
cld contacts add Customers --first-name Ada --last-name Lovelace --company-name "Analytical Engines"
cld contacts set "Customers:Ada Lovelace" --job-title Mathematician --parent "Customers:Analytical Engines"
cld contacts mv "Customers:Ada Lovelace" Alumni
```

The name after the colon in `add` becomes the contact's label. `--email`, `--phone`, and `--tag` are repeatable and replace the whole list; `label=value` sets an email or phone label. `--parent none` removes the parent. For addresses, websites, bank accounts, or other structured fields, pass API JSON with `--from <file|->`; flags win over the same field in the file. Read `cld contacts add --help` for every field flag.

## Notes, tags, and exchange

```bash
cld contacts notes add "Customers:Ada Lovelace" --content "Met at the archive."
cld contacts notes list Ab12Cd --json
cld contacts tags list Customers --json
cld contacts tags add "Customers:Conference 2026" --color "#2563eb"
cld contacts tags update "Customers:Conference 2026" --name "Conference"
cld contacts export Customers --format csv --out customers.csv
cld contacts import Customers --from contacts.vcf --dry-run
cld contacts import Customers --from contacts.vcf
```

Long note text comes from `--from <file|->`. `export` writes vCard (default) or CSV to stdout, or to `--out`. `import` reads vCard; contacts that match an existing one by email or full name are skipped unless `--include-duplicates` is given. `--dry-run` shows the preview without creating contacts. `import` exits 1 when any contact fails. Export and import need admin permission on the book.

## Books and access

```bash
cld contacts books add "Customers" --description "Active customers"
cld contacts books update Customers --name "Clients"
cld contacts access list Customers --json
cld contacts access grant Customers --group "Editors" --permission write
cld contacts access set Customers --user ada.lovelace --permission admin
```

`access set` is idempotent. Read `cld contacts access revoke --help` before revoking access.

## Destructive operations

`rm`, `books delete`, `tags delete`, and `notes delete` ask for confirmation in a terminal. Without a terminal they refuse unless `--yes` is given. `access revoke` always needs `--yes`. Resolve the exact target with `show` first and pass its ID.

## Command reference

All commands support the global options `--json`, `--profile`, `--server`, `--token`, and `--locale`. Run `cld contacts <command> --help` for flags.

| Command | Purpose |
| --- | --- |
| `ls [<book>]` | Books, or the contacts of a book; `--q`, `--tag`, `--page`, `--per-page`. |
| `show <contact>` / `show <book>:` / `show --email <address>` | One contact or book. |
| `search <query>` | Contacts across all readable books. |
| `add <book>[:<name>]` | Create a contact. |
| `set <contact>` | Change fields. |
| `mv <contact> <book>` | Move to another book. |
| `rm <contact>` | Delete; confirmation or `--yes`. |
| `tree <contact>` | Hierarchy around a contact. |
| `export <book>` | vCard or CSV; `--format`, `--out`. |
| `import <book> --from <file\|->` | vCard import; `--dry-run`, `--include-duplicates`. |
| `books add\|update\|delete` | Contact books. |
| `tags list\|add\|update\|delete` | Tags of a book. |
| `notes list\|add\|update\|delete` | Notes on a contact. |
| `access list\|grant\|set\|revoke\|search-principals` | Direct access grants. |

## JSON contracts

Treat JSON fields as the contract and tolerate additional fields.

- `ls` without a book and `search` return `{ data, pagination }`. `ls <book>` returns `{ book: { id, name }, data: Contact[], pagination }`.
- `show`, `add`, `set`, and `mv` return the contact: `{ id, bookId, label, firstName, lastName, companyName, jobTitle, emails, phones, addresses, tags, parentContactId, updatedAt, … }`. `show <book>:`, `books add`, and `books update` return the book: `{ id, name, description, createdAt, updatedAt }`.
- `rm` returns `{ deleted: { id, bookId, name } }`; `books delete` and `tags delete` return `{ deleted: { id, name } }`; `notes delete` returns `{ deleted: { id, contactId } }`.
- `tags list` and `notes list` return arrays of tags and notes.
- `export --out` returns `{ book: { id, name }, format, output }`. `import --dry-run` returns `{ book, candidates: [{ candidate, match }] }`; `import` returns `{ book, created, skipped, failures }`.
- Errors in `--json` mode are printed to stderr as `{ "error": { "message", "status", "exitCode" } }`. Ambiguity has status `409`.
