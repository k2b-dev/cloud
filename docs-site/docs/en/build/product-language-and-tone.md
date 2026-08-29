---
title: Write product text
navTitle: Product language and tone
section: Build an app
order: 170
description: Write clear English and German labels, feedback, errors, notifications, and Help without changing product meaning.
tags: [writing, copy, tone, english, german, i18n, errors, help]
updated: 2026-08-29
---

# Write product text

Cloud product text helps a person understand the current state and take the
next safe action. Write in a calm, direct, and precise voice. Keep one term per
concept and preserve the same product meaning across locales.

This guide covers wording. [Internationalization](/en/docs/build/internationalization)
covers message catalogs, locale resolution, formatting, SSR, and transport
boundaries.

## Use one product voice

| Principle | Write this way | Avoid |
| --- | --- | --- |
| Calm | State what happened without drama | Jokes, blame, or generic apologies |
| Direct | Lead with the state or action | “Please note that” and other opening filler |
| Precise | Name the object, effect, and recovery | “Something went wrong” when the failure is known |
| Respectful | Explain constraints without blaming the reader | “You entered an invalid value” |
| Restrained | Describe the actual capability | Marketing adjectives or vague ease claims |

Prefer a specific verb over a noun phrase. Write “Cloud validates the address”
instead of “Cloud performs validation of the address”. Use active voice when
the actor matters. Passive voice is useful when the result matters more than
the actor, as in “The invoice was saved”.

Do not explain what the interface already makes clear. Add text when it helps a
person decide, recover, or understand a consequence.

## Write short controls

Short controls must remain clear without surrounding prose.

- Buttons use a specific verb and, when useful, its object: “Create invoice”,
  “Save changes”, or “Delete warehouse”.
- Navigation labels name destinations: “Payment settings”, not “Configure your
  payment settings”.
- Field labels name the value: “Invoice date”, not “Enter an invoice date”.
- Statuses describe the current state: “Waiting for approval”, not “Approve”.
- Icon-only controls have a localized accessible name that identifies the
  action and target.
- Use sentence case. Keep product names, abbreviations, and proper nouns in
  their established form.

Settings labels follow the same sentence-case rule. Name the value, not its
storage format: prefer “Reindex schedule” over “Reindex Cron”. Put exact
syntax and examples in the description or example value.

Avoid “OK”, “Submit”, and “Continue” when the concrete action is known. A
destructive confirmation button names the destructive action.

| Context | English | German |
| --- | --- | --- |
| Primary action | Create invoice | Rechnung erstellen |
| Navigation | Payment settings | Zahlungseinstellungen |
| Status | Waiting for approval | Wartet auf Freigabe |
| Icon action | Remove “Quarterly report” | „Quartalsbericht“ entfernen |

## Write one-sentence guidance

A label carries the field's meaning. Use text inside an empty input only for an
example or required format, never as the only label. A hint explains a
constraint, why the value is needed, or what will happen next. A tooltip
contains supplementary information, not a requirement that is necessary to
complete the task.

Write the instruction directly:

| Avoid | Prefer |
| --- | --- |
| Please enter the email address that should be used. | Enter the billing email address. |
| This field is for the number of days. | Number of days before the invoice is due. |
| e.g. John Doe | Example: Maria Schmidt |

Localize examples when their format or cultural context changes. Keep literal
syntax such as IDs, paths, flags, or accepted date patterns exact.

## Explain states and outcomes

Each state answers the question a person has at that moment.

| State | Answer | Example |
| --- | --- | --- |
| Loading | What is happening? | Loading invoices… |
| Success | What completed? | Invoice created. |
| Empty | What belongs here, and how can I add it? | No invoices yet. Create an invoice to start billing. |
| Validation | What needs correction? | Enter an amount greater than zero. |
| Recoverable error | What failed, and what can I do next? | Invoices could not be loaded. Try again. |
| Blocking error | What is unavailable, and where can I continue? | You do not have access to this warehouse. Return to Inventory. |
| Warning | What will the action change? | Removing this member also removes their access to the workspace. |

Do not present unavailable or failed content as empty. Do not announce success
until the server has confirmed the change. If a write succeeds but the view
cannot refresh, say that the change was saved and offer to refresh the view.

For errors, state the known fact first and a safe recovery second. Mention
preserved work when that reduces uncertainty. Do not expose stack traces,
internal identifiers, or operational detail as recovery guidance.

Stable error codes remain unchanged and untranslated. Localize the human
message, field guidance, and recovery action. Clients branch on the code, not
on translated text.

Do not show HTTP statuses, stack traces, or internal error codes as interface
copy. They belong in structured diagnostics and logs. A person needs the
failed object, the effect, and a safe recovery action.

## Ask for confirmation

Use confirmation when a person needs to understand scope, consequence, or
irreversibility before an action. Name the action and object in the title,
state the concrete consequence in the body, and repeat the action on the
confirmation button.

```text
Delete warehouse?

This removes Warehouse North and its assignments from Inventory. This action
cannot be undone.

[Cancel] [Delete warehouse]
```

```text
Lager löschen?

Dadurch werden das Lager Nord und seine Zuordnungen aus dem Inventar entfernt.
Diese Aktion kann nicht rückgängig gemacht werden.

[Abbrechen] [Lager löschen]
```

Avoid “Are you sure?” because it does not explain what the person is agreeing
to. Do not claim that an action can be undone unless the product provides that
recovery.

## Write notifications and other compact messages

Lead with the domain change, not the delivery mechanism. A notification title
states what changed. Its body adds only the context needed to assess the event.
Its action opens the relevant destination.

- Keep sensitive details on the authorized destination page.
- Do not repeat the title in the body.
- Avoid urgency unless the underlying event has a real deadline or risk.
- For delayed work, render with the recipient locale saved for that work, not
  an unrelated current request locale.

For email, keep the subject specific and make the plain-text version complete.
See [Notifications](/en/docs/platform/notifications) for rendering and delivery
contracts.

## Write Help and other long-form content

One Help article serves one reader goal. Start with what the person can achieve,
then give the shortest complete path. Put prerequisites and meaningful
consequences before the step they affect. Use task headings, exact interface
labels, and observable success or recovery guidance.

- Prefer short paragraphs and steps with one action each.
- Keep terminology stable across the interface, Help, errors, and search text.
- Explain a concept only when the reader needs it to complete or understand the
  task.
- Keep commands, code, configuration keys, paths, package names, identifiers,
  flags, literals, and exact external labels verbatim.
- Translate or summarize surrounding prose without changing supported meaning.

Avoid stock introductions, repeated summaries, and conclusions that only
repeat the page. In English, remove frames such as “It is important to note
that”. In German, avoid bureaucratic frames such as “Es ist zu beachten, dass”,
long noun chains, and unnecessary Anglicisms.

Localized Help uses the same stable article IDs and logical structure as the
base locale. A translation may be idiomatic and need not mirror sentence order,
but it must not add a promise, permission, limitation, or workaround absent
from the base article. See [In-product Help](/en/docs/platform/help) for the
folder and fallback convention.

## Keep English and German equivalent

Translate intent, facts, and consequences rather than word order. Both versions
must communicate the same state, scope, permission boundary, uncertainty, and
recovery path.

For German product text:

- Address the person with informal `du` when a pronoun is necessary.
- Write `du`, `dich`, `dir`, and possessive forms in lowercase except at the
  start of a sentence.
- Prefer a direct imperative when it reads naturally, such as “Wähle ein
  Lager”.
- Prefer neutral role nouns such as “Person”, “Team”, or “Mitglieder”. Use an
  established role label when the exact role matters.
- Write idiomatic German instead of copying English grammar or compounds.
- Use established German terms unless the product or domain has an established
  untranslated name.

The `du` form addresses the Cloud user. An artifact produced for a third party
follows the conventions of that artifact and reader. German invoices, quotes,
contracts, and formal external email may therefore use `Sie`.

For English product text, use “you” when the reader's responsibility matters.
Otherwise, a direct action or state is usually shorter.

Do not translate product names, application names, identifiers, routes, codes,
or exact labels from an external system unless their owning contract defines a
localized presentation. Formatting of numbers, currencies, dates, times,
durations, plurals, and lists follows the resolved locale rather than a manual
word substitution.

| Intent | English | German |
| --- | --- | --- |
| State | No payment method is configured. | Es ist keine Zahlungsmethode eingerichtet. |
| Recovery | Choose a payment method and try again. | Wähle eine Zahlungsmethode und versuche es erneut. |
| Permission | Ask a workspace administrator for access. | Bitte eine Person mit Administratorrechten für den Workspace um Zugriff. |

## Keep messages safe to translate

Each catalog entry should express a complete thought. Do not concatenate
translated fragments or rely on English word order. Pass semantic values to a
message function and use locale-aware plural, list, number, and time formatters.

Treat these shapes as translation bugs:

- keys ending in `Before`, `After`, `Prefix`, `Suffix`, `Start`, or `End` that
  split one sentence;
- a translated value passed into another translated message;
- a status word, adjective, or article inserted as a message argument;
- `toLowerCase()`, `toUpperCase()`, capitalization helpers, or suffix changes
  applied to resolved text.

Case and grammatical agreement belong to each locale. German articles and
adjectives change with gender, number, and case, so write a complete qualified
message for each state instead of inserting an English-shaped fragment.

```ts
saved: ({ name }: { name: string }) => `${name} was saved.`,
```

Use separate complete messages when grammar changes by state. Branch on the
stable state code, never on translated text. Accessibility
labels, alternative text, validation guidance, and screen-reader-only status
updates are product text and require the same localization as visible text.

## Review product text

Before shipping a new or translated surface, check:

1. Does the text state what is true now and the next safe action?
2. Does each control name its actual effect and each status name a state?
3. Are destructive scope, consequences, and recovery accurate?
4. Can a person recover from each validation or runtime error?
5. Is essential guidance visible without relying on in-field example text or a tooltip?
6. Does one term represent each concept across UI, Help, and notifications?
7. Do English and German preserve the same facts, permissions, and uncertainty?
8. Are codes, identifiers, paths, and exact external labels unchanged?
9. Are values formatted through locale-aware helpers instead of embedded text?
10. Are visible and assistive messages both localized?

Read the final text in its interface context. Remove words that do not change
meaning, but keep the context needed for a safe decision.
