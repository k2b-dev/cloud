---
id: faq-admin
title: Maintain FAQs
icon: ti ti-edit
description: Write useful questions, choose audiences, preview Markdown, and retire outdated entries.
order: 110
---

Each FAQ entry should answer one question a reader is likely to recognize. Keep product procedures in the owning app's Help and use FAQ for short cross-cutting answers.

## Write an entry {icon="pencil"}

:::steps
1. Write the complete English question and answer.
2. Add both German fields when the entry should be available in German; otherwise leave both empty.
3. Put the direct answer in the first sentence.
4. Add only the steps, conditions, or links needed to act.
5. Select every audience that should see the answer.
6. Save and verify both language variants on the public FAQ.
:::

English is the required fallback for every entry. The public FAQ uses the
visitor's exact locale, then its language, then English. Audience and list
position apply to the complete entry, not to one translation.

## Choose an audience {icon="shield-lock"}

- **Anonymous** is for people who are not signed in.
- **Guest** is for guest-profile accounts.
- **User** is for full user accounts.
- Select multiple audiences when the answer is valid for more than one group.

:::warning Audience is visibility, not redaction
Do not place secrets or private operational data in an FAQ answer. Audience filtering controls which entry is listed; it is not a substitute for safe content.
:::

## Maintain the list {icon="point"}

- Update names and instructions when the corresponding UI changes.
- Remove duplicate entries by keeping the clearest question and linking to a longer Help topic when needed.
- Delete an entry only when the answer is no longer valid or useful to any selected audience.

## Automate with the CLI {icon="terminal"}

Administrators can list, create, update, reorder, and delete the same entries
with `cld faq`. Run `cld faq help` for commands and pass localized Markdown as
a translations JSON file or through standard input. Every translations object
must include English and may include any additional valid locale.
