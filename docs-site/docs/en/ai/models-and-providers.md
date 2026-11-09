---
title: Models and providers
navTitle: Models and providers
section: AI
order: 1020
description: Configure models and providers without exposing credentials to application clients.
tags: [ai, models, providers]
updated: 2026-11-08
---

# Models and providers

Configure a provider connection, add its models, then assign model variants to
classes. Applications request a class; the operator can change its model
without changing application code. This release removes the old profile
configuration. Follow [Upgrading to model classes](/en/docs/operations/upgrading-to-model-classes)
before upgrading an existing installation.

Browser and CLI clients import model request schemas, picker types,
`aiModelClassFallbackChain`, `aiModelSupportsSlot` and `aiReplacementProblem`
from `@k2b/cloud/shared`. Use the latter two when offering assignment and
replacement choices; the server enforces the same requirements. The `@k2b/cloud/ai`
entry point executes server work and must not be bundled into a client.

## Create a provider connection

In **Administration → AI → Models**, choose **Add provider**. If the provider
was created but its key or headers could not be saved, retry to finish those
steps. The dialog keeps the created provider and its current revision.

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

## Choose the data boundary

The data boundary says where a provider may process data:

| `dataBoundary` | Administration label | Who uses its models |
| --- | --- | --- |
| `private` | Private | Everyone the model is shared with, including apps with private data |
| `hosted` | Hosted | Everyone the model is shared with; private data stays on private models |
| `restricted` | No privacy commitment | Only application server code that names a model ID |

Choose `restricted` for a provider that makes no data-protection commitment,
such as a free API tier that may train on its inputs. Cloud keeps its models
away from every use by a person:

- Assistant chat, the model picker, workflows, code and the
  OpenAI-compatible API never offer or run them;
- classes, the image tool, the audio tool and live dictation cannot be
  assigned to them, so a class request never resolves to one;
- they get no chat access: new models are not shared with signed-in people,
  and saving a grant fails with `restricted_boundary`;
- the provider accepts only chat models; audio models fail with
  `restricted_boundary`.

The boundary is fixed for `restricted`: a provider never changes to or from
it, and such an update fails with `boundary_fixed`. Running chats and
background tasks keep a model they already resolved, so a later change could
not take effect safely. Create a new provider for another boundary. Private
and hosted providers can still switch between those two.

An application uses such a model by storing its ID in an application setting
and passing `model: { id }` from server code; see
[Use a model without a data-protection commitment](/en/docs/ai/structured-and-background-ai#use-a-model-without-a-data-protection-commitment).
Copy the ID from the model's **Access** section. **AI → Usage** shows which
application calls which model.

Supply a key separately with `cld admin ai providers key local --key-file key.txt --yes`.
Keys and additional headers are encrypted and write-only. Reads return
`credentialSet` and `requestHeaderNames`. A stored key does not mean the
connection has been tested successfully. Extra headers are supported for vLLM
and OpenAI-compatible connections. Changing the connection type or base URL
clears the stored key and additional headers and resets the connection status.
Enter the key again and test the connection after either change.

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

The model dialog proposes globally unique IDs using the provider and model
identifier. Open **Advanced** to correct an ID before creating models. When
the provider returns an empty model list, enter its model identifier manually.

Declare only capabilities supported by the provider model. Chat models can
support tools and vision. Audio models use `kind: "transcription"`, support
OpenAI or OpenAI-compatible providers, and have only their standard variant.
Decision models use `kind: "decision"`, an OpenAI-compatible provider and a
required `contextWindow`. They support token prices, have only a standard
variant, and never appear as chat models. Optional `vision` is the
administrator’s declaration of image support by both the provider and model;
Cloud does not probe it. cortecs currently ignores decision images. See
[Configure decision models](/en/docs/operations/decision-models) before upgrading.

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
slot requires a transcription model. The `decision` slot requires a decision model. These slots do not use class fallback.
Use `none` in the CLI to empty a slot.

## Update request settings and prices

Inspect a model and its variants, then update only the fields you want to change:

```bash
cld admin ai models show local-chat --json
cld admin ai models update local-chat --input-file model-patch.json --yes --json
cld admin ai variants update local-chat:deep --input-file variant-patch.json --yes --json
```

A model patch can set shared prices or parameters:

```json
{ "pricing": { "inputPerMillion": 0.5, "outputPerMillion": 2 }, "extraBody": { "custom": true } }
```

A variant patch can set the thinking level and override parameters or prices:

```json
{ "reasoningEffort": "low", "extraBody": null, "pricing": null }
```

Only supplied fields change. JSON `null` clears an optional value; clearing a
variant's prices restores its model's prices. Use the model ID alone to update
its standard variant. Commands also accept `--input <json>` or `--stdin` and
read the current model or variant revision before writing.

## Set the output budget

Reasoning and the visible answer share the output-token budget. A small limit
can leave no space for the answer after the model has reasoned. Set **Max output**
on the model or variant when you need a fixed budget; a variant overrides its
model, and an explicit per-request limit overrides both. Usage allowances can
still reduce a request's budget.

When no limit is configured, thinking-capable models use the provider-reported
output maximum, bounded by the estimated context space left after the prompt,
history, tools and response schema. Without a reported output maximum, they
retain the provider's default: a context window alone does not establish how
much output a provider accepts. Cloud does not take a fixed percentage of the
context window. This is an estimate, not a guarantee of the provider's tokenizer
or sufficient space for every answer.

Thinking-capable means a non-`none` reasoning effort, an enabled thinking or
reasoning parameter, or the adapter's thinking capability. Generic
OpenAI-compatible endpoints advertise that capability by default, so they get
this conservative budget even when no effort is configured. `reasoningEffort:
"none"` and non-thinking endpoints retain the provider's default. An explicit
output limit always takes precedence over this automatic rule.

Discovery preserves `max_output_tokens` (or OpenRouter's
`top_provider.max_completion_tokens`) as `outputTokenLimit` when adding a model
through administration. An existing model can set this catalog field through
the model update API or CLI; `null` clears it. Services using `@k2b/cloud` 0.63
keep reading the catalog after the 0.71 upgrade without a library update.
For older thinking-capable catalog entries without either output setting,
Cloud tries the provider's model listing
when resolving the model. This lookup is bounded to ten seconds; unavailable
listings do not block generation. Saving the reported limit in the catalog
avoids that extra lookup. Set the model's `contextWindow` to its documented
value too: without it, the adapter's context window is used (128,000 tokens for
a generic compatible endpoint). Provider defaults and reported limits can
change; verify them against the provider's model documentation.

Nessi 1.2.0 has no typed separate reasoning-token budget. Cloud uses the shared
output budget; provider-specific `extraBody` parameters remain an operator choice.

An answer that reaches its output limit stays completed. Assistant and the
shared Gustav chat renderer show a persistent notice below it, including when
reasoning consumed at least 80% of its measured output tokens. **Continue
writing** sends a follow-up request to finish the answer, using the chat's
current model. The notice remains visible after reloading the chat.

## Set the thinking level

Set `reasoningEffort` on a variant. Chat uses that variant's setting. Every
provider type is reached through its OpenAI-compatible chat endpoint, so the
level is sent as `reasoning_effort`, or as `reasoning.effort` for OpenRouter.
Anthropic's OpenAI compatibility ignores it and returns no thinking text.
Structured tasks and compaction keep their task reasoning policy: low for
OpenAI, OpenRouter, vLLM and OpenAI-compatible providers, none for Gemini, and
provider defaults for the others. Provider-specific `extraBody` still applies.

Endpoint headers belong to provider connections. Configure them in administration
or use `PUT /api/admin/core/ai/providers/{id}/headers` with the current provider
`revision` and a `headers` patch. A string sets a header, `null` removes it, and
omitted names keep their values. Reads expose names only.

## Change or remove configuration

Updates require the current row's `revision`. A stale revision returns HTTP
409 with `code: "conflict"`, the full current object, `changedBy` and
`changedAt`. Read that object before deciding what to save again. In the
administration editor, changes to different fields merge automatically.
Choose between the displayed values for fields both people changed; **Your
value** is the default. Budget rules merge against the rule originally read,
while preserving other rules added in the meantime.

Inspect `/api/admin/core/ai/models/:id/usage` before deleting a model. Delete
requests supply replacements for every affected slot, including explicit
`null` choices, and decide whether to retarget projects, workflows and their
scheduled tasks. A replacement must preserve the model kind and required
capabilities and keep the same or a stricter data boundary. Private models
cannot be replaced by hosted models, and no reference can be replaced by a
`restricted` model.

Retargeting notifies owners. Without retargeting, fixed references fail when
next used. Running answers finish, and their history remains. A chat whose
explicit variant was removed falls back to the person's class, or balanced,
on its next turn and records a `model_replaced` timeline marker.

See [Structured and background AI](/en/docs/ai/structured-and-background-ai)
for the application contract and [OpenAI-compatible API](/en/docs/ai/openai-compatible-api)
for external clients.

Budget report links use `/admin/ai?sec=budgets&rule=people`; filtering and
pagination keep that selection. Old `ai-quotas` settings links redirect to
the people report by default, or the budget list for `view=rules`.
