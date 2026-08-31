# FAQ

FAQ entries contain one translations object, one audience list, and one shared
position. All `cld faq` commands require an administrator profile.

## Inspect Entries

```bash
cld faq list
cld faq get <id> --json
```

Use `--json` for one complete machine-readable result or `--jsonl` when
streaming list entries.

## Write Localized Content

Create a JSON object keyed by locale. English is required; any other valid
locale is optional.

```json
{
  "en": { "question": "What is Cloud?", "answer": "Cloud is ..." },
  "de": { "question": "Was ist Cloud?", "answer": "Cloud ist ..." }
}
```

Pass that object directly, from a file, or through standard input:

```bash
cld faq create --translations-file ./translations.json --audience anonymous,guest
cld faq update <id> --translations-file ./translations.json
cld faq update <id> --audience user
```

Valid audiences are `anonymous`, `guest`, and `user`. Repeating
`--audience` and comma-separated values are both supported.

## Order and Delete

`reorder` replaces the complete ordering, so pass every current entry ID once.
Read the list first and preserve entries that should remain.

```bash
cld faq reorder <first-id> <second-id> <third-id>
cld faq delete <id> --yes
```

Deletion is irreversible and requires `--yes`.
