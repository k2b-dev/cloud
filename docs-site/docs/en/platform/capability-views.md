---
title: Capability views
navTitle: Capability views
section: Platform services
order: 553
description: Show a capability result, an approval's details, and a search preview with the same declarative blocks as Code pages.
tags: [capabilities, views, blocks, approvals, search]
updated: 2026-11-08
---

# Capability views

A capability returns `data` for machines and, optionally, a `view` for people.
Gustav reads `data` as before. The person sees the view. The terminal and MCP
receive the same view as text.

A view uses the block vocabulary of [Code pages](/en/docs/platform/code-page):
the same components draw a Code page, a result in the conversation, the details
of an approval, and the preview of a search hit. A view has no state, no
script, no markup, and no expressions. Cloud checks every view before anyone
sees it.

## Where a view appears

| Place | Who supplies it | What Cloud adds |
| --- | --- | --- |
| Result of a Query or Action | `CapabilityResult.view` | The origin line "App · Title", **Open large**, and the data toggle |
| Approval of an Action | `review.view` of the Action's review | Head, sentence, reason, expiry, answers, and outcome line ([Approvals](#approvals)) |
| Preview of a search hit | The `view` of the result of the Type's `reader` | App, title, and **Open in App** ([Search previews](#search-previews)) |

There is no third contract field. The search preview calls the reader of the
active hit, so the reader's permission check applies.

## Return a view

```ts
return ok({
  data: { matches, categories },
  summary: "8 similar objects, 23 sales since 2019.",
  view: {
    version: 1,
    blocks: [
      {
        kind: "Cards",
        title: "Similar objects",
        items: { from: ["matches"] },
        card: { id: ["id"], title: ["title"], subtitle: ["meta"], image: ["imagePath"], facts: [{ label: "Hammer price", value: ["hammer"] }] },
      },
      {
        kind: "Choice",
        id: "category",
        title: "Which category fits best?",
        mode: "one",
        options: { from: ["categories"] },
        option: { id: ["id"], title: ["label"], subtitle: ["hint"] },
        submit: "Narrow down",
        then: { query: "art.query.search-similar", input: { objectId: "o_81" }, field: "categoryId" },
      },
    ],
  },
});
```

Values stand in the view directly or point into `data` by path:

- `{ from: ["matches"] }` takes a list from `data`. It is allowed for
  `Stats.items`, `Table.rows`, `Detail.items`, `Cards.items`, `Choice.options`,
  and the value lists of a chart.
- Mappings such as `card.title: ["title"]`, `option.id: ["id"]`, or a table
  column's `path` are relative to each item.
- A path is a list of literal own property names, at most 16 segments.
  `__proto__`, `constructor`, and `prototype` are rejected. There are no dotted
  strings, templates, or conditions.

Cloud stores the raw result and binds the paths when it reads it, on the
server, so the server render and the first browser render agree.

Write every label in the language of the request (`context.locale`). Cloud's
own words, such as "Open large" or "Chosen by you", follow the reader's
locale.

## Blocks by place

| Block | Code page | Result | Approval | Search preview |
| --- | --- | --- | --- | --- |
| `Section`, `Text`, `Heading`, `Notice` | yes | yes | yes | yes |
| `Stats`, `Table`, `Detail`, `Chart`, `Cards`, `Image` | yes | yes | yes | yes |
| `Link` | own Code paths | Cloud paths of the app, resource links, `https:` | Cloud paths | Cloud paths |
| `Form`, `Button`, `Action` | yes | no | no | no |
| `Choice` | no | yes | no | no |
| `Draft` | no | no | yes | no |

New and changed blocks:

| Block | Fields |
| --- | --- |
| `Cards` | `title`, `items`, `card: { id, title, subtitle?, image?, imageAlt?, badges?, facts?, rating?, price?, href? }`, `choose?` (the `id` of the tree's `Choice`), `empty?`, `width?` |
| `Image` | `src`, `alt`, `ratio?`, `caption?` |
| `Detail` | Each item may add `before` (the old value, shown struck through) and `type: "status"` with `states` as in `Table` |
| `Table` | Outside Code pages a column names a `path` instead of a `key`; optional `rowId` and `rowHref` |
| `Choice` | `id`, `title`, `description?`, `mode: "one" \| "many"`, `options`, `option: { id, title, subtitle? }`, `submit`, `then?` |
| `Draft` | `context?` (read-only rows, text or people) and `fields` (`text`, `textarea`, or `select` from the Code page form fields) |

The renderer, never the app, decides depth. A frame with a chart or table and a
card with an image are islands; key figures, text lists, and the options of a
choice stay flat. A view in the conversation has no hull of its own. Blocks
take `width` (`third`, `half`, `twoThirds`, `full`) as a share of the row; a
narrow place stacks them.

## Limits

| Limit | Value |
| --- | --- |
| Nodes per view | 256 |
| Depth | 12 |
| Rows, cards, and options per block | 200 |
| Table columns | 20 |
| Key figures | 6 |
| Detail rows | 100 |
| Draft fields | 40 |
| Open choices per view | 1 |
| Drafts per view | 1 |
| Result with its view | 256 KiB of UTF-8 JSON (the result limit) |
| Review without its view | 32 KiB |
| Review view | 16 MiB; a view with a `Draft` at most 256 KiB |

Cloud checks the data before it binds, budgets the binding, and checks the
bound tree for the place. A result whose view breaks a rule fails as an invalid
application response; Cloud never drops or shortens a block silently.

## Links and images

- **Images** load only from the answering app's own registered routes, as
  root-relative paths such as `/art/images/m_12`. Cloud never loads a picture
  from another server; `https:`, `data:`, and protocol-relative sources are
  rejected. The page keeps `img-src 'self'`. Serve a remote picture through your
  app's route, as Mail does for external images. Without `alt`, the card title
  is the text alternative.
- **Links** in a result go to a path of the answering app, a Cloud resource link
  (`/open/<type>/~<id>`), or an `https:` address. Links in an approval or a
  search preview stay on Cloud paths. Encoded separators, dot segments, and
  `javascript:` are rejected.
- App blocks never draw a filled button or the head of an approval. Inside an
  approval, Cloud labels the app's part "Details from App".

## Choices

A `Choice` asks the person to pick one or more of the view's options. Only the
person can answer it:

1. The answer button is active while no response runs and the choice is open.
2. The browser posts `{ turnId, toolCallId, blockId, ids }` to
   `POST /api/ai/conversations/:id/choices`. Cloud binds the stored result
   again and checks the ids; otherwise it answers `409`.
3. Cloud writes the person's message with the choice and starts a response.
   Gustav reads the choice as the person's own message and cannot write one
   itself.
4. With `then`, Cloud first calls that Query of the same app with
   `then.input` plus `{ [field]: id }` (a list for `mode: "many"`), marked with
   the origin `choice`. `then` never names an Action; Actions always go through
   an approval.
5. A newer open choice of the same app closes older ones ("No longer open").
   After an answer and after a reload, the chosen options stay marked with
   "Chosen by you" and the time; the block is read-only.

An API key, OAuth token (such as `cld`), or delegated credential receives `403`
when trying to answer a choice.

Set `choose` on `Cards` to draw the choice's options as those cards. Card `id`s
must match the choice's option ids.

## Approvals

An Action review returns `review.view` for the thing it changes. Cloud draws
the rest with one approval component in every place; see
[Approval card](/en/docs/ai/tools-and-approvals#one-approval-card).

| Before | Now |
| --- | --- |
| `preview.kind: "message"` with `content.message` | `Draft`: sender, recipients, and attachments as `context`; subject `text`, body `textarea` |
| `preview.kind: "page"` with `content.page` | `Draft`: place as `context`; title `text`, content `textarea` |
| `preview.kind: "event"` | `Detail` (title, time, place, attendees) |
| `preview.kind: "task"` | `Detail` with a `status` row; a `Table` for a checklist |
| `preview.kind: "file"` | `Detail`, with an `Image` from your own route for pictures |
| `preview.kind: "rule"` | `Text` for what it does and `Detail`; what it may do stays in `consequences` |
| `preview.kind: "fields"` with `before` | `Detail` with `before` |

A `Draft` is a small form for any app. Its labels stand above the fields. Each
field `name` must be a top-level key of the Action's input. Things that need a
picker, such as people, places, or files, stay read-only `context` rows; offer
a review link with `rel: "edit"` to change them in your app. Mail never makes
recipients editable in the conversation.

## Search previews

A Type whose `reader` returns a `view` gets a rich preview in Universal Search.
The browser calls `GET /api/search/preview?type=<type>&id=<id>` for the hit the
person rests on, 150 ms after the last move, cancels the previous request, and
keeps answers while the dialog is open. Cloud calls the reader as the person and
binds its view for the `preview` place, which allows no `Choice` and no
`Draft`. Without a reader view, on an error, a timeout, or without access, the
column shows the search facts (`metadata`, `preview`, `previewUrl`) as before.

## Text for terminals, MCP, and the model

- `cld assistant` prints the result's `summary` and the view as text
  (`blocksText`). `cld assistant` and ACP clients print an open choice as a
  numbered list with a link to answer it in Cloud, because only the person in
  a signed-in browser session can answer a choice.
- MCP keeps the whole result as `structuredContent` and puts the summary and
  the view text before the JSON text.
- The model receives `data` as before plus a short description of what the
  person sees (`blocksSummary`), not the view itself. Gustav does not repeat
  the view as text.

`bindView`, `validateBlocks`, `blocksText`, and `blocksSummary` come from
`@k2b/cloud/blocks`; the renderer `BlockTree` comes from
`@k2b/cloud/blocks/ui`.
