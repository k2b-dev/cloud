---
title: Cloud glossary
navTitle: Glossary
section: Reference
order: 1245
description: Use one English and one German term for each Cloud product concept in Help and interface text.
tags: [glossary, terminology, writing, help, english, german]
updated: 2026-10-10
---

# Cloud glossary

Use the term in this glossary for each product concept. Do not use the listed
synonyms. One term has one meaning in English and in German.

The glossary covers words that people read in Cloud: Help articles, labels,
messages, and notifications. The developer vocabulary is in
[Vocabulary and statuses](/en/docs/reference/vocabulary-and-statuses).

[Write app help](/en/docs/build/write-app-help) explains how to apply it.
The `help-writing` repository check reads the tables on this page and reports
each listed synonym in the built-in Help articles.

## How the check matches a term

- A term matches whole words. A hyphenated word, such as `double-click`, does
  not match `click`.
- `*` at the end of a term also matches longer words: `Berechtigung*` matches
  `Berechtigungen`.
- A term that starts with a lowercase letter also matches it with a capital
  first letter anywhere, so `admin` matches `Admin area`. A term that starts
  with an uppercase letter matches only that spelling, so `Rechte` does not
  match `rechte Spalte`.
- The check reads a paragraph as a whole, so a term or a code span can wrap
  across source lines.
- Code, bold interface labels, and link targets are not checked. Quote an
  interface label exactly as the interface shows it, even if it uses a listed
  synonym.

A dash means that the check has no synonym for that column. Some meanings
cannot be checked automatically; the **Meaning** column then says when to use
the term.

## Access and identity

| English | German | Meaning | Not in English | Not in German |
| --- | --- | --- | --- | --- |
| access | Zugriff | What a person, group, or service account can do with a resource. Write “give access”, „Zugriff geben“. | `permission`, `permissions`, `rights`, `privilege`, `privileges`, `grant`, `grants`, `granted`, `granting` | `Berechtigung*`, `Zugriffsrecht*`, `Rechte`, `Rechten` |
| **View**, **Edit**, **Manage** | **Ansehen**, **Bearbeiten**, **Verwalten** | The shared access levels. Write “**Edit** access”, „Zugriff **Bearbeiten**“. An app with its own level labels quotes those labels. | `read access`, `write access`, `admin access`, `admin rights` | `Lesezugriff`, `Schreibzugriff`, `Adminzugriff`, `Leserecht*`, `Schreibrecht*`, `Adminrecht*`, `Administratorrecht*`, `Verwaltungsrecht*`, `Bearbeitungsrecht*` |
| administrator | Administration | The role that manages the Cloud installation in the admin area. A person with **Manage** access to one resource is not an administrator. | `admin`, `admins`, `sysadmin` | `Admin`, `Admins`, `Administrator`, `Administratoren`, `Administratorin*` |
| account | Konto | The sign-in identity of one person. | — | `Account`, `Benutzerkonto*` |
| service account | Dienstkonto | An account that is not a person. It acts with its own access; a user-bound service account acts with the current access of its person. | `service user`, `technical user`, `bot`, `bots` | `Servicekonto*`, `Service-Account*`, `Dienstaccount*`, `Bot`, `Bots` |
| agent | Agent | A service account that appears as an agent in pickers, activity, and audit. | — | — |
| sign in, sign out | anmelden, abmelden | Start or end a session. | `log in`, `log out`, `logged in`, `login`, `logon` | `einloggen`, `ausloggen`, `eingeloggt`, `ausgeloggt`, `Login` |
| API key | API-Schlüssel | A secret that an integration uses instead of a password. | `API token`, `API tokens` | `API-Token*`, `API-Key*` |

## Sharing and work

| English | German | Meaning | Not in English | Not in German |
| --- | --- | --- | --- | --- |
| share, sharing | teilen, Freigabe | Give other people access to a resource. „Freigabe“ is the sharing area or one share. In new text it never means an approval. | — | `Zugriffsfreigabe*`, `Lesefreigabe*` |
| approve, approval | genehmigen, Genehmigung | A person confirms a change before it takes effect. | `sign off`, `sign-off` | — |
| claim | übernehmen | Take a task or a shift so that others see who works on it. Use „übernehmen“ only in this sense; for settings write „anwenden“ or „speichern“. | `pick up`, `grab` | `beanspruchen` |
| assign, assignee | zuweisen, zugewiesene Person | Make a person responsible for an item. An assignment is not a claim. | — | — |
| notification | Benachrichtigung | A message from Cloud about a change or an event. | — | `Mitteilung*`, `Notification*` |

## Content

| English | German | Meaning | Not in English | Not in German |
| --- | --- | --- | --- | --- |
| app | App | A Cloud application such as Mail or Spaces. | `application`, `applications` | `Anwendung`, `Anwendungen`, `Applikation*` |
| delete | löschen | Destroy an object or move it to the trash. | — | — |
| remove | entfernen | Take an object out of a list, a group, or a link. The object continues to exist. | — | — |
| trash | Papierkorb | Deleted items wait here until Cloud deletes them permanently. | `bin`, `recycle bin`, `wastebasket` | `Mülleimer` |
| folder | Ordner | A container for files. Use “directory”, „Verzeichnis“ only for the user directory. | — | — |
| upload | hochladen | Copy a file from a device to Cloud. | — | `uploaden` |
| email | E-Mail | A message sent through an email address. Mail is the app. | `e-mail`, `e-mails` | `Email`, `Emails`, `eMail` |

## Interaction

| English | German | Meaning | Not in English | Not in German |
| --- | --- | --- | --- | --- |
| choose | wählen | Activate a button, menu item, tab, or option with a mouse, touch, or keyboard. | `click*`, `tap`, `taps`, `tapped` | `klick*`, `anklick*` |
| select | auswählen | Mark one or more items, for example with a checkbox. | — | — |
| press | drücken | Use a key on the keyboard. Write the key in bold: **Enter**. | — | — |

## Known interface conflicts

The interface still uses some terms against this glossary. These are the main
conflicts. Help quotes these labels exactly until the interface changes, and
new interface text follows the glossary.

- Access tabs and columns in several apps say **Permissions**,
  **Berechtigungen**, or **Zugriffsrechte**.
- Role labels say **Admin**, and so does the English access level of an API
  key.
- Notebooks labels who can delete and lock notes **Everyone who can write**,
  **Alle mit Schreibrechten**, and **Admins only**, **Nur Admins**.
- The Assistant and the Grids equipment loan template use „Freigabe“ and
  „freigeben“ for approvals, for example **Freigabe erforderlich**, **Immer
  freigeben**, **Gespeicherte Freigaben**, and **Ausleihe freigeben**. Grids
  labels the approver group **Freigabegruppe**.
- Spaces labels “take over a claim” **Übernehmen**, the same word as the claim,
  and “release a claim” **Übernahme freigeben**.
- The Mail editor labels “apply” **Übernehmen**.
- Grids names Durable history **Dauerhafter Verlauf** in the table settings,
  **Beständige Historie** in the Base settings, and **Nachweisbarer Verlauf**
  in the record panel.
- German sign-in messages ask people to contact „einen Administrator“.
