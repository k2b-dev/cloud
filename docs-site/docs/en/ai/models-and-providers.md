---
title: Models and providers
navTitle: Models and providers
section: AI
order: 1020
description: Configure models and providers without exposing credentials to application clients.
tags: [ai, models, providers]
updated: 2026-10-27
---

# Models and providers

Configure a provider connection, add its models, then assign model variants to
classes. Applications request a class; the operator can change its model
without changing application code. This release removes the old profile
configuration. Follow [Upgrading to model classes](/en/docs/operations/upgrading-to-model-classes)
before upgrading an existing installation.

## Create a provider connection

Use `cld admin ai providers add --input-file provider.json --yes`. For example:

```json
{
  "id": "local",
  "type": "ollama",
  "label": "Local inference",
  "baseUrl": "http://inference:11434",
  "dataBoundary": "private"
}
```

The provider owns its connection type, base URL, data boundary, enabled state,
and optional logo. A missing URL uses the provider's default; OpenAI-compatible
connections require an explicit URL. IDs cannot change after creation.

Supply a key separately with `cld admin ai providers key local --key-file key.txt --yes`.
Keys and additional headers are encrypted and write-only. Reads return
`credentialSet` and `requestHeaderNames`. Extra headers are supported for vLLM
and OpenAI-compatible connections.

Run `cld admin ai providers test local` to test the connection, or
`cld admin ai providers models local` to discover provider model identifiers.
Tests and discovery time out after ten seconds. A rejected key, unreachable
connection, and other failure have distinct status codes. Runtime calls also
update connection status; a later success clears a previous failure.

## Add models and variants

Use `cld admin ai models add local --input-file models.json --yes`. The file
contains one model or an array:

```json
{
  "id": "local-chat",
  "providerModel": "qwen3",
  "label": "Local chat",
  "description": "For everyday questions",
  "capabilities": ["tools", "vision"]
}
```

Declare only capabilities supported by the provider model. Chat models can
support tools and vision. Audio models use `kind: "transcription"`, support
OpenAI or OpenAI-compatible providers, and have only their standard variant.
Streaming is a provider runtime capability, not a model configuration field.

Every model gets a standard variant with the model's ID. Add named variants
with `cld admin ai variants add local-chat --input-file variant.json --yes`:

```json
{ "slug": "deep", "label": "Thorough", "hint": "For difficult questions", "reasoningEffort": "high" }
```

This variant's selectable ID is `local-chat:deep`. Variants inherit the model's
connection, capabilities, access and limits. They can override output limits,
prices and parameters. Variant `extraBody` entries replace matching model
entries. An empty hint uses the model description. `showInPicker: false` hides
an option from people's model lists without preventing an assigned class from
using it. The standard variant cannot be deleted separately.

Model access and budget rules apply to every variant of the model. Prices are
per million input and output tokens in the installation's accounting unit.
Missing or zero prices do not consume a priced chat allowance. Audio has no
token pricing. A variant can override its model's prices.

## Assign classes and tools

```bash
cld admin ai classes set balanced local-chat --yes
cld admin ai classes set thorough local-chat:deep --yes
cld admin ai classes set vision local-chat --yes
cld admin ai classes show --json
```

The fixed classes are `fast`, `balanced`, `thorough`, and `maximum`, in that
order. An omitted request uses `balanced`. Empty classes try these alternatives:

| Requested class | Fallback order |
| --- | --- |
| `fast` | `balanced`, `thorough`, `maximum` |
| `balanced` | `fast`, `thorough`, `maximum` |
| `thorough` | `balanced`, `fast`, `maximum` |
| `maximum` | `thorough`, `balanced`, `fast` |

Fallback applies only to empty assignments. Access denial, exhausted budgets,
disabled models and incompatible capabilities fail without choosing another
class. With all four classes empty, requests fail with `ai_no_model`. With AI
disabled, they fail with `ai_disabled`.

The `vision` slot requires a chat model with vision capability. The `audio`
slot requires a transcription model. These slots do not use class fallback.
Use `none` in the CLI to empty a slot.

## Set the thinking level

Set `reasoningEffort` on a variant. Chat uses that variant's setting. Structured
tasks and compaction keep their task reasoning policy: low for OpenAI,
OpenRouter, vLLM and OpenAI-compatible providers, none for Gemini, and provider
defaults for the others. Provider-specific `extraBody` still applies.

## Change or remove configuration

Updates require the current row's `revision`. A stale revision returns HTTP
409 with `code: "conflict"`, the full current object, `changedBy` and
`changedAt`. Read that object before deciding what to save again.

Inspect `/api/admin/core/ai/models/:id/usage` before deleting a model. Delete
requests supply replacements for every affected slot, including explicit
`null` choices, and decide whether to retarget projects, workflows and their
scheduled tasks. A replacement must preserve the model kind and required
capabilities and keep the same or a stricter data boundary. Private models
cannot be replaced by hosted models.

Retargeting notifies owners. Without retargeting, fixed references fail when
next used. Running answers finish, and their history remains. A chat whose
explicit variant was removed falls back to the person's class, or balanced,
on its next turn and records a `model_replaced` timeline marker.

See [Structured and background AI](/en/docs/ai/structured-and-background-ai)
for the application contract and [OpenAI-compatible API](/en/docs/ai/openai-compatible-api)
for external clients.
