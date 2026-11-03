---
title: Detail panels
navTitle: Detail panels
section: Frontend
order: 825
description: Build an object's detail panel from the shared sections, in one order of use, with every state and one text edge.
tags: [detail panel, presence, access, links, properties, tags, progressive disclosure]
updated: 2026-11-03
---

# Detail panels

The detail panel answers "what is this, who is here, and what belongs to it"
for the object open in an application. Every Cloud application builds it the
same way, so people find the same things in the same places in Notebooks,
Spaces, Files, Mail, and third-party apps.

Build it from [`DetailPanel`](/en/ui/layout/detail-panel) inside
`AppWorkspace.Detail` and its shared sections. The application passes data;
the sections own their icon, title, count, states, and geometry.

## Put sections in the order of use

Show what people work with first and let context wait:

| Order | Section | Use it when | Building block |
| --- | --- | --- | --- |
| 1 | Here now | Several people can have the object open live | `DetailPresence` |
| 2 | Fields people edit | The object has fields such as status, owner, or due date | Property rows in `DetailPanel.Section` |
| 3 | Comments | People discuss the object | `Discussion` |
| 4 | The object's own content | It has parts to jump to or progress to show, such as an outline or tasks | `DetailPanel.Section` with `DetailPanel.Action` rows |
| 5 | Tags | The object carries tags | `DetailTags` |
| 6 | Links | Other objects link to it or it links to them | `DetailLinks` |
| 7 | Attachments | Files belong to it | `DetailPanel.Section` with `FileGrid layout="list" limit={5}` |
| 8 | More about … | Access, facts, and history | `DetailPanel.Group` with `DetailAccess`, `DetailProperties`, and activity |

Leave out what the object does not have. A section with nothing in it yet,
such as tags or links of a new object, shows its title and "None yet" in one
row, so people still learn that the object can have them.

## Disclose the rest progressively

- Sections 1 to 7 stand open. Long lists show their first rows and "Show n
  more": three comments, five links per direction, five attachments, five
  people with access.
- "More about …" holds closed sections. Each says in its summary what it
  holds, such as "Lager-Team, Jana Berger and 5 more" or "412 words ·
  created 3 days ago".
- A list the page does not need for its first paint, such as access, loads
  right after it, once per page, and shows its loading state in its place
  until then.

## Keep one edge and every state

Every section has an icon. Everything below a section title starts on the
title's text edge, including row icons and avatars; only a real sub-level,
such as an H3 in an outline, indents further. The shared sections, rows, and
`FileGrid` keep this edge on their own: do not add padding or negative
margins around them. See
[One edge per section](/en/ui/layout/detail-panel#one-edge-per-section).

Each section keeps its height while its data changes. "Here now" is always
two lines tall: people coming, going, or moving between headings change only
its content. Give every section its states:

- loading: placeholders of the final height;
- empty: "None yet" or a hint, such as how to add a tag;
- error: what failed and "Try again";
- offline: the last known state, pale, with the time it is from.

On phones the panel is the workspace's bottom sheet, in the same order. Its
chips and rows are taller for touch; nothing else changes.

## Show who is here from the object's live channel

Pass `DetailPresence` the people of the object's existing live channel, such
as a collaborative editor's awareness: name, avatar, the person's color, and,
when known, whether they write and where. Do not open a second channel for
presence. Map the channel's connection to `state`: `loading` until the first
list arrives, `live` while it follows, `unavailable` with `onRetry` after it
failed, and `offline` when the page has lost its connection. Writing people
with a place get `onSelect`, which goes to their place.

## Show who has access, read-only

Everyone with access of their own may see who else has access and with which
role. People who read only through a public link never see the section. Make
this decision on the server, both for the list endpoint and for the page that
decides whether to show the section; see
[Show who has access](/en/docs/identity/authorization#show-who-has-access).
Pass "Manage access" only to people who may change access. The section never
changes a grant itself.

## Check it

- Open the panel at desktop and phone width, light and dark.
- Measure the edge: the left edge of every visible text, icon, avatar, and
  chip in each section body equals its title's left edge.
- Change the data the panel follows, such as people coming and going, and
  compare the positions and sizes of the sections before and after.
- Call the access list as a member, as a public-link reader, and without
  access.

Notebooks' note panel is the reference: its browser test
`detail-panel.browser.test.ts` measures the edge and the presence changes,
and `access-members.integration.test.ts` checks who may read the access list.
