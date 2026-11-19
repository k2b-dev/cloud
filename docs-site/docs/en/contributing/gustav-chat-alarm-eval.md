---
title: Evaluate Gustav alarms
navTitle: Alarm eval
section: Contributing
order: 1341
description: Check that Gustav sets, postpones and deletes chat alarms as the Skill describes.
tags: [testing, ai, chat, scheduling]
updated: 2026-11-19
---

# Evaluate Gustav alarms

`packages/assistant/src/evals/chat-alarms.ts` holds fictional cases for
[scheduled chat messages](/en/docs/ai/chat-alarms). Each case has a fixed clock,
the person's time zone, the turn trigger, the chat's alarms before the request,
the request and a review rubric:

| Case | Trigger | Expected result |
| --- | --- | --- |
| `set-once` | person | One `wakeup_create` at 16:00 Europe/Berlin |
| `set-repeating` | person | One `wakeup_create` with `cron: "0 8 * * 1-5"` or `mon-fri` |
| `move-by-sentence` | person | `wakeup_list`, then `wakeup_update` of the same alarm to 17:00 |
| `postpone-in-alarm-turn` | alarm | `wakeup_list`, then `wakeup_update` with only a later `at` |
| `postpone-limit` | alarm | No change after three postponements |
| `delete` | person | `wakeup_list`, then `wakeup_delete` of the named alarm |
| `limit-reached` | person | No alarm at five alarms; a refused create is acceptable |
| `automation-instead` | person | No alarm for an event request; Code authoring may follow |

`chat-alarms.test.ts` checks the alarm fixtures against the public
`AiWakeupSchema` and checks the scorer with fixed traces. It moves the system
clock to another year to prove that the scorer uses only the case clock. It makes
no agent or application calls.

```sh
bun --no-env-file test packages/assistant/src/evals/chat-alarms.test.ts
```

Print a case:

```sh
bun packages/assistant/scripts/eval-chat-alarms.ts --case set-once
```

Run each request in a fresh Gustav chat in an isolated evaluation installation
at the case clock. Create the listed alarms first through the
[alarm API](/en/docs/ai/chat-alarms#create-and-change-alarms). A person's edit
resets the postponement count, so `postpone-limit` needs three earlier alarm
turns that each postpone the alarm. For an alarm case, let the alarm deliver its turn, and use a fictional mailbox without the
expected reply. Never use real mail, personal chats or a production
installation. Record model, commit and the loaded Skill content with the result.
Capture decoded tool inputs and results and the final answer as
`{calls: [{name, args, result, isError?}], answer}`. Keep failed calls.

Score the trace offline:

```sh
bun packages/assistant/scripts/eval-chat-alarms.ts --case set-once --trace /path/to/trace.json
```

The scorer counts successful alarm changes. A case expects exactly one change
of the named kind, or none. Inputs must match the public alarm schemas, and
times compare as instants. A repeat may pass its first occurrence as `at`. An update or delete must use the revision from a
`wakeup_list` call earlier in the same trace. In an alarm turn, an update may
change only `at`, to a time after the case clock, and any `wakeup_create` call
fails. Any `code_*` tool call fails every case except `automation-instead`.

A mechanical pass needs a review against the case rubric: the note's wording
and language, the one-sentence confirmation without cron or IDs, the
explanation at limits, and that nothing activates Code. Tools report refusals as
text, such as the five-alarm message, not as error codes.
