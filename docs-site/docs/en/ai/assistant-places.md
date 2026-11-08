---
title: Assistant at a place
navTitle: Place context
section: AI
order: 575
description: Declare resource-specific context, tools, skills, and starters for a person's Assistant chat.
tags: [ai, assistant, capabilities, context]
updated: 2026-11-08
---

# Assistant at a place

A resource Type can add context, tools, Skills, and starting questions to the
person's normal Assistant chat. Declare an `assistant` block on the Type and
return the current selection from a Query. The same API works for built-in and
third-party applications.

## Connect a resource page

Report the resource through the existing page context on `Layout`:

```tsx
import { Layout } from "@k2b/cloud/ssr";

<Layout
  c={c}
  title={[{ title: conversation.title }]}
  context={{ scope: { type: "example.conversation", id: conversation.id } }}
>
  {children}
</Layout>
```

Use the namespaced Type and the public ID its reader accepts. The scope selects
the place; it grants no access. Your normal page and domain-service permission
checks still apply. A Type without an `assistant` block keeps the normal panel
unless the person already has a chat bound to it; that chat shows as unavailable.

For a place that changes inside one document, publish the current scope with
`publishPageContext` from `@k2b/cloud/browser/panel` and dispose the previous
publication. See [Layout and navigation](/en/docs/frontend/layout-and-navigation#render-the-application-layout)
for the existing publication and cleanup contract.

## Declare the provider and allowed tools

Import `AssistantPlaceSchema` and `defineCapabilities` from
`@k2b/cloud/contracts`. The Type's `assistant` block has three fields:

| Field | Meaning |
| --- | --- |
| `provider` | Local ID of a Query in this application. It targets this Type, accepts an empty strict object, and declares `data: AssistantPlaceSchema`. |
| `tools` | Allowed local Action IDs in this application. Every Action targets this Type and declares `destructive: false` and `openWorld: false`. |
| `skills` | Allowed Skill names. These may belong to any application. Skills must exist at startup; this declaration grants no access to them. |

The Type must also declare a reader. The provider is a closed-world,
person-readable Query; it needs no additional resource references. Cloud checks
these contracts at application startup. Skills shipped by the starting
application are checked against its `skills` catalog; other names must already
exist in a published application Skill catalog. Publish those catalogs before
starting applications that depend on their names. Catalogs persist across app
restarts; this check does not depend on live Skill reconciliation.

```ts
import { AssistantPlaceSchema, type CapabilityExecutionContext, defineCapabilities } from "@k2b/cloud/contracts";
import { z } from "zod";

export const createPlaceCapabilities = (conversations: {
  read(id: string, ctx: CapabilityExecutionContext): Promise<{ title: string; summary: string }>;
}) => defineCapabilities({
  protocolVersion: 2,
  types: {
    conversation: {
      title: "Conversation",
      description: "A customer conversation.",
      reader: "conversation.read",
      assistant: {
        provider: "conversation.assistant",
        tools: [],
        skills: [],
      },
    },
  },
  queries: {
    "conversation.read": {
      title: "Read conversation",
      description: "Read an authorized customer conversation.",
      input: z.object({ id: z.string().describe("Conversation ID.") }).strict(),
      data: z.object({ title: z.string() }).strict(),
      openWorld: false,
      run: async (input, ctx) => {
        const conversation = await conversations.read(input.id, ctx);
        return { ok: true, data: { data: { title: conversation.title } } };
      },
    },
    "conversation.assistant": {
      title: "Assistant context",
      description: "Read the person's current context at this conversation.",
      target: "conversation",
      input: z.object({}).strict(),
      data: AssistantPlaceSchema,
      openWorld: false,
      run: async (_input, ctx) => {
        if (!ctx.target) throw new Error("Conversation target required");
        const conversation = await conversations.read(ctx.target.id, ctx);
        return {
          ok: true,
          data: {
            data: {
              title: conversation.title,
              context: conversation.summary,
              tools: [],
              skills: [],
              starters: [{ label: "Summarize", prompt: "Summarize this conversation." }],
            },
          },
        };
      },
    },
  },
});
```

Pass your permission-aware domain service as `conversations.read`. It must refuse
resources the caller cannot read, as on your other API paths. See
[App capabilities](/en/docs/platform/capabilities) for resource readers, result
envelopes, targets, and Action policies.

## Return the current place

`AssistantPlaceSchema` is a strict object with the following fields:

| Field | Bound |
| --- | --- |
| `title` | Required string, 1–200 characters. |
| `context` | Required Markdown string, at most 32 KiB encoded as UTF-8. |
| `tools` | Required array, at most 16 local Action IDs from `assistant.tools`. |
| `skills` | Required array, at most 8 names from `assistant.skills`. |
| `starters` | Optional array, at most 3 `{ label, prompt }` objects; labels have at most 80 characters and prompts at most 500. |

The declaration supplies the allowed set; the Query chooses a subset for the
current person and state. For example, return no tools when the person can read
but cannot write. Cloud drops and logs IDs outside the declared set. Invalid or
oversized results make the place unavailable.

The context is application data, including potentially untrusted customer text.
It is not an instruction channel. Keep it relevant to this resource and do not
include data the person cannot read.

## Platform provider dispatch

The trusted Cloud host uses `runPlaceProvider(authority, placeRef, { locale?, signal? })`
from `@k2b/cloud/ai`. It invokes the current provider through the existing
capability dispatcher with the person's authority and the exact resource target.
Pass the current request authority from `getAuthority(c)`; executor hosts use
`resolveAiCapabilityActor` to refresh the conversation owner first. The helper
preserves credential limits and delegation metadata.

A result is `AssistantPlace` or `{ unavailable: true, retry?: true }`. A missing
place and refused access both return `{ unavailable: true }`. Temporary provider
failures and invalid contracts include `retry: true`; show a retry state instead
of claiming access was lost. Contract failures are logged without context content.
Cancellation propagates to the caller.

This helper neither checks panel consent nor creates a chat. Panel hosts must
check consent before invoking it. Applications declare the provider and enforce
resource permissions in their domain service.

## Load the panel without creating a chat

Cloud checks the person's consent to share page context before it invokes the
provider. The initial server render and later navigation use the same
`loadPlaceAssistant(c, scope)` loader from `@k2b/cloud/ai/server`. Panel hosts can
read the same projection from `GET /api/ai/places/:type/:id`.

| State | What the host can show |
| --- | --- |
| `none` | No place context; keep the ordinary panel. |
| `consent_required` | The existing consent flow, before querying the provider. |
| `available` | Place title, application identity, Type title, selected tool policies, Skills, starters, and the person's existing chat or `null`. |
| `unavailable` | Stored title and the person's chat ID when known; no current place tools or context. `retry: true` means the provider may recover. |

The response contains display metadata, never the provider's raw `context`.
Loading it is read-only. Opening the panel, navigating to a place, and clicking
a starter without sending do not create a chat.

## Keep one personal chat per place

The first message creates a chat bound to the person and the exact place ref.
Another person opening the same resource gets their own chat. Sharing the
resource does not share its Assistant history.

A place has one non-archived chat per person. **Start over** (**Neu beginnen**)
archives that chat and returns to the place's empty state. The next sent
message creates a replacement; the previous history stays in the archive.
Restoring the old chat while its replacement is active returns `409 CONFLICT`;
archive the replacement first.

Panel hosts create a chat through `POST /api/ai/conversations` with `place: {
type, id }`, a nonempty `draft.content`, and the normal `requestId` for retries.
This path takes the title from the current provider. It does not accept the
ordinary creation overrides for title, Project, tools, Skills, or launching app.

If the person already has an active chat at this place, open it using the
loader's `conversationId`. A create request with a different draft returns
`409 CONFLICT`. Without consent the request returns `403`; an unavailable place
returns `404`. After creation, draft saving and submission use the normal chat
flow.

On navigation, the panel follows the new place when an empty chat or a place
chat is open. Another open chat stays visible, with **Switch to <title>**
(**Zu <Titel> wechseln**) in the place bar. A response for an earlier page must
not replace the current place: hosts match both the page ID and sequence of
the current page context.

Place chats appear in search under **At places** (**An Orten**) and in the
separate place filter. Unread and attention counts include them. Ordinary chat
lists and own-chat discovery omit them by default. Lists include them with
`place=any` or an exact `<type>:<id>`; the own-chat search tools include them only
with an exact place ref. See [List place chats](/en/docs/ai/chat-runtime-and-streaming#list-place-chats)
for API filters, counters, and `cld assistant chats list --place`.

## Refresh context and handle an unavailable place

Before each model round, including after resume, Cloud reloads the provider
with the conversation owner's current authority. The place stored on the chat
remains its selector even after the page changes. Context is marked as untrusted
application data. Returned Skills join the permission-filtered catalog and are
loaded through the normal Skill mechanism; listing one grants no access.

Withdrawing consent removes place context, tools, and Skills from later rounds;
pending place Actions end as `rejected`.

If the resource disappears or the person loses access, their chat history
remains readable. New rounds receive no place context, tools, or Skills. The panel shows **No longer have access to <title>**
(**Kein Zugriff mehr auf <Titel>**) using the stored title when available.
Temporary provider or contract failures carry `retry: true`; hosts should offer
a retry without presenting them as permanent loss of access. A place whose
application is not currently registered also returns `retry: true`, because
Cloud cannot tell a removal from a restart.

## Fixed targets and current access

Cloud removes Actions declared in `assistant.tools` from the general Assistant
catalog. In a place chat, only the current provider selection is available.
Their tool schemas omit the target field: Cloud supplies the resource stored on
the chat. Other explicit resource references remain ordinary Action inputs.

Before each place Action, including execution after an approval or a resumed
turn, Cloud reloads the person and the provider. An inactive person, unavailable
place, or Action absent from the current selection ends the call as `rejected`.
A previous approval grants no continued resource access. Action policies and
remembered approvals otherwise follow the normal Assistant flow.

The chat stays readable after place access is lost. Tool audit rows retain their
conversation link, which supplies the person and immutable place coordinates.
