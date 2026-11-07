---
title: Next-message suggestions
navTitle: Next-message suggestions
section: Operations
order: 950
description: Runtime and migration notes for personal suggestions after interactive chat answers.
tags: [ai, upgrades, chat]
updated: 2026-11-07
---

# Next-message suggestions

Interactive browser chats can generate one suggested next message in the same
model response as the answer. Generation uses the chat's model, provider,
data boundary and budget. There is no additional service, credential or
environment variable. A sole closing call ends without another inference request.

The AI migration adds `suggested_next_message` and `suggestion_user_id` to
`ai.messages` (and preserves the matching background-history table shape), and `suggest_next_message` to `ai.user_prefs`. Existing and new
people default to enabled. Run the normal Core migration before starting
application images that use this runtime contract. Existing messages receive
no suggestion; existing preferences keep their other values.

Clients may read the optional `suggestedNextMessage` answer field and must
honor `dismissedAt`. The server projects it only to the person who triggered
the latest completed answer. Exports, indexing, enrichment, notifications and
model history omit it. Old clients can ignore the new field; their usual chat
and approval paths remain available. See the [chat contract](/en/docs/ai/chat-interface#suggest-the-next-message)
for preference and dismiss routes.

When the person turns suggestions off, or the turn is not an interactive
browser chat, the tool and its prompt subsection are absent. Missing or
invalid tool calls leave the answer without a suggestion.

Maintainers can evaluate the frozen, invented cases with
`bun packages/cloud/scripts/eval-next-message.ts --model balanced --out report.json`
and again with `--model fast`, using the installation's existing model catalog
and credentials. `--help` lists the required configuration. The harness reads
configuration without changing chats or preferences. It checks language,
length, repetition, visible numbers and addresses, names, and the five
positive intents. Name and language checks use a fixed vocabulary for these
fixtures; they are regression checks, not general language or entity detection.
N8–N10 permit a different, safe suggestion and specifically test repetition,
hidden tool data and German output from English source data. At least four of
the five positive cases must pass, at most one negative case may produce an
unwanted suggestion, and privacy and repetition must have no violations.
