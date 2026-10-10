---
title: Write app help
navTitle: Write app help
section: Build an app
order: 175
description: Write English and German Help articles with short steps, one term per concept, and warnings before the risky step.
tags: [help, writing, english, german, glossary, steps]
updated: 2026-10-09
---

# Write app help

Cloud Help follows the principles of ASD-STE100 (Simplified Technical English)
in an adapted form. The rules below apply to English and German Help alike.
[Product language and tone](/en/docs/build/product-language-and-tone) covers
the voice of all product text; this page adds the rules for Help articles.
[In-product Help](/en/docs/platform/help) covers the file format and
registration.

## Why Help is written this way

People open Help in the middle of a task. They scan for the next action,
often in their second language. The Assistant and the MCP server read the same
articles and quote them. Short sentences with one action and one term per
concept serve all of these readers. They also keep English and German
equivalent.

Cloud does not adopt the strict STE dictionary. A fixed word list makes text
stiff. Help keeps natural words and controls only the product terms through the
[Cloud glossary](/en/docs/reference/glossary).

## Follow the writing rules

| Rule | Write this way |
| --- | --- |
| One term, one meaning | Use the glossary term for each product concept. Do not vary terms for style. |
| Steps for procedures | Write each procedure as numbered steps. Write one action per step sentence, in the imperative. |
| Short sentences | Keep step sentences at 20 words or fewer and other sentences at about 25 words or fewer. |
| Active voice, present tense | Name who acts: you, a person, or the app. Write “Mail saves the draft”, not “The draft will be saved”. |
| Warnings first | Put a warning or caution before the step it concerns, never after it. |
| Three nouns at most | Do not stack more than three nouns. Split a stack with a verb or a preposition. A German compound counts each of its parts. |
| No filler | Remove “please”, “just”, “basically”, “note that”, „bitte“, „einfach“, „Es ist zu beachten, dass“. |
| Clear verbs | Write “must” or “can”, not “should” or “may”. Write the exact action, not “handle”, „verwalten“ or „behandeln“. |
| Exact labels | Quote an interface label in bold, exactly as the interface shows it in that language: **Save changes**, **Änderungen speichern**. Write menu paths with →: **Settings → Sharing**. |
| Most important first | Start with what the reader can do. Do not repeat a fact that the page already states. |

German Help follows the same rules: kurze Sätze, Aktiv, Imperativ mit „du“ in
Anleitungen, ein Begriff für eine Bedeutung. Write idiomatic German, not
translated English word order.

## Structure an article

- **One task per article.** The title names the task as the reader thinks of
  it: “Share a Space”, „Space teilen“. An overview, reference, or
  troubleshooting article names the reader's question instead: “Fix calendar
  problems”.
- **Frontmatter.** `title` is the task. `description` is one sentence that says
  what the reader can do. Both appear in search and in agent results, so they
  follow the glossary too.
- **First sentence.** Say what the reader achieves and what they need first,
  for example an access level.
- **Sections.** Each level-two heading is one subtask and is also written as a
  task: “Invite people”, not “Invitations”.
- **Order in a section.** Prerequisites and warnings, then the steps, then the
  result the reader sees, then the next step if there is one.
- **Facts.** Put facts that the reader looks up, not follows, in a `reference`
  block. Put alternatives in a `compare` block.

## Learn from real Help

These examples come from the built-in Help before the rewrite.

### Keep step sentences short

| | Before | After |
| --- | --- | --- |
| English | 4. **Share with the right people:** Invite users or groups once the structure is clear enough that they can act without extra explanation. | 4. **Share the Space:** Invite people and groups when the structure is clear. They can then start without extra explanation. |
| German | 4. **Mit den passenden Personen teilen:** Lade Personen oder Gruppen ein, sobald die Struktur klar genug ist, damit sie ohne zusätzliche Erklärung mitarbeiten können. | 4. **Space teilen:** Lade Personen und Gruppen ein, sobald die Struktur klar ist. Dann arbeiten sie ohne zusätzliche Erklärung mit. |

### Put the warning before the step

Before: the reader learns that the change is permanent two paragraphs after
the instruction. The German text also names the setting differently from the
settings dialog.

```md
A Base admin can enable **Durable history** in **Table settings → History and
protection**. This permanent opt-in captures existing records, then appends
every create, update, trash, restore, Relation and File state.
[…] Durable history increases storage use, has no disable action, […]

Basis-Administratoren können unter **Tabelleneinstellungen → Verlauf und
Schutz** den **Nachweisbaren Verlauf** dauerhaft aktivieren. […] Der
nachweisbare Verlauf erhöht den Speicherbedarf, kann nicht deaktiviert werden […]
```

After:

```md
:::warning You cannot turn Durable history off
Durable history keeps every record version and uses more storage over time.
:::

:::steps
1. Open **Table settings → History and protection**.
2. Turn on **Durable history**.
:::

:::warning Du kannst den dauerhaften Verlauf nicht ausschalten
Der Verlauf behält jede Version eines Datensatzes und braucht mit der Zeit mehr Speicher.
:::

:::steps
1. Öffne **Tabelleneinstellungen → Verlauf und Schutz**.
2. Schalte **Dauerhafter Verlauf** ein.
:::
```

### Use the access levels that the interface shows

Before: the interface labels the levels **View**, **Edit**, and **Manage**. The
Help text uses three other names, and German uses three more.

```md
:::note Admin-only settings
Only Space administrators can manage wormholes, the GitHub token, access, API
keys, and deletion. Writers can manage shared Space details, tags, statuses, […]

:::note Einstellungen mit Adminzugriff
Nur Personen mit Adminzugriff können Wormholes, das GitHub-Token,
Zugriffsrechte, API-Schlüssel und das Löschen verwalten. Personen mit
Schreibzugriff können gemeinsame Angaben zum Space, Tags, Status, […]
```

After:

```md
:::reference
- **Manage:** Change wormholes, the GitHub token, access, API keys, and deletion.
- **Edit:** Change the Space details, tags, statuses, and Kanban columns.
- **View:** Change your personal defaults and copy the calendar feed.
:::

:::reference
- **Verwalten:** Wormholes, GitHub-Token, Zugriff, API-Schlüssel und Löschen ändern.
- **Bearbeiten:** Angaben zum Space, Tags, Status und Kanban-Spalten ändern.
- **Ansehen:** Eigene Voreinstellungen ändern und den Kalender-Feed kopieren.
:::
```

### Remove filler and say what to do

| | Before | After |
| --- | --- | --- |
| English | Spaces are collaborative surfaces. Permissions should match the people who are allowed to read, update, or administer the shared work. | Give each person and group only the access they need in this Space. |
| German | Spaces sind Bereiche für gemeinsame Arbeit. Berechtigungen sollten zu den Personen passen, die diese Arbeit lesen, bearbeiten oder verwalten dürfen. | Gib jeder Person und Gruppe nur den Zugriff, den sie in diesem Space braucht. |

### Turn a procedure in prose into steps

Before:

```md
By default, everyone who can write in a notebook can also delete its notes and
lock them permanently. Neither can be undone. To keep notes from disappearing or
freezing by accident, an admin opens **Sharing — Access** and sets **Who can
delete and lock notes** to **Admins only**. The change saves immediately.

Anfangs dürfen alle mit Schreibrechten die Notizen eines Notizbuchs auch löschen
und endgültig sperren. Beides lässt sich nicht rückgängig machen. Damit Notizen
nicht versehentlich verschwinden oder eingefroren werden, öffnet ein Admin
**Freigabe – Zugriff** und stellt **Wer darf Notizen löschen und sperren** auf
**Nur Admins**. Die Änderung wird sofort gespeichert.
```

After: the label **Admins only** stays, because the interface shows it.

```md
By default, everyone with **Edit** access can delete and lock notes. You cannot
undo either action. With **Manage** access, you can limit both actions:

:::steps
1. Open **Sharing — Access**.
2. Set **Who can delete and lock notes** to **Admins only**.
:::

Notebooks saves the change immediately.

Anfangs können alle mit Zugriff **Bearbeiten** Notizen löschen und sperren. Beides
lässt sich nicht rückgängig machen. Mit Zugriff **Verwalten** schränkst du beides ein:

:::steps
1. Öffne **Freigabe – Zugriff**.
2. Stelle **Wer darf Notizen löschen und sperren** auf **Nur Admins**.
:::

Notebooks speichert die Änderung sofort.
```

### Break up noun stacks

| | Before | After |
| --- | --- | --- |
| English | Grids has two Cloud permission boundaries: a **Base** for the complete raw workspace and a **Grids App** for one published, task-focused surface. | Grids controls access in two places. Access to a **Base** covers everything in it. Access to a **Grids App** covers only that published app. |
| German | Grids besitzt zwei Cloud-Berechtigungsgrenzen: eine **Basis** für den vollständigen unmittelbaren Arbeitsbereich und eine **Grids App** für eine veröffentlichte, auf eine Aufgabe ausgerichtete Oberfläche. | Grids regelt den Zugriff an zwei Stellen. Zugriff auf eine **Basis** gilt für alles darin. Zugriff auf eine **Grids App** gilt nur für diese veröffentlichte App. |

## Check Help in this repository

The `help-writing` rule checks every Help article under `packages/*/src/help`
in the Cloud repository. It reports:

- a sentence in a numbered step with more than 20 words;
- a synonym that the [Cloud glossary](/en/docs/reference/glossary) lists for
  the article's language, in titles, descriptions, headings, and prose.

The rule cannot judge voice, order, or meaning. Review those by reading the
article in the Help panel.

```bash
bun scripts/check.ts help-writing              # check
bun scripts/check.ts help-writing --warnings   # also list known findings with their lines
bun scripts/check.ts help-writing --fix        # remove fixed findings from the baseline
```

Findings that existed when the rule started are listed in
`scripts/checks/help-writing.baseline`. The rule reports them as known
findings and does not fail on them. A new finding fails `bun run check`. A
baseline line whose finding is gone fails too, so the baseline only shrinks.
The Help rewrite fixes articles in batches and removes their lines with
`--fix`. When the baseline is empty, delete the file; from then on the rule
enforces every finding.

Third-party applications can apply the same rules and glossary. The check
itself reads the Cloud repository layout and is not part of the public
package.
