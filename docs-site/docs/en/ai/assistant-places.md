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
