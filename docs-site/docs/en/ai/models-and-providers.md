---
title: Models and providers
navTitle: Models and providers
section: AI
order: 1020
description: Configure models and providers without exposing credentials to application clients.
tags: [ai, models, providers]
updated: 2026-09-16
---

# Models and providers

Administrators configure model profiles. Applications select them through a
policy.

A profile names the provider and model. It also records capabilities and the
data boundary used for policy checks.

## Configure a profile in administration

Open **Settings → AI → Providers** and add or edit a profile. The compact dialog
has four collapsible sections. Opening another section preserves your draft:

- **Connection:** choose **Text / Chat** or **Audio transcription**, the provider,
  display name and provider model identifier. Audio supports OpenAI and
  OpenAI-compatible endpoints. The endpoint and API key sit side by side;
  profile ID and logo are visible directly below. Field hints distinguish a
  stored key, an unsaved key and a missing key. Leave an existing key field
  empty to keep it, including when reopening an unsaved profile draft.
  An empty endpoint uses the provider default unless a custom URL is required.
- **Costs:** optionally enable reference prices for input and output per million
  tokens. Prices use the installation's shared accounting unit. The example
  shows the estimated cost of 10,000 input and 2,000 output tokens. Missing
  prices mean unknown costs and unrestricted use: chat budgets and the
  background cost brake do not cover that model. Explicit zero prices mean
  free usage. Audio has no reference pricing or cost guard.
- **Access:** choose who may use the model in Assistant and set its data
  boundary. Model access and cost budgets remain separate settings.
- **Advanced:** enable or disable the profile, choose its supported chat
  capabilities and optionally set context, output or tool limits. The default
  output limit also bounds budget reservations; tasks can override it. Leave it
  empty to retain the provider default. **Image analysis**
  is a Text / Chat capability, not a separate usage category.

**Apply to draft** updates the settings form. Save that form to persist the
configuration and permissions. Canceling the dialog discards its edits.

## Use a model policy

```ts
modelPolicy: {
  kind: "selectable",
  allowedDataBoundaries: ["private"],
  requiredCapabilities: ["streaming", "tools"],
}
```

| Policy | Behavior |
| --- | --- |
| `platform-default` | Uses the configured platform default |
| `locked` | Uses one model profile |
| `selectable` | Lets the caller choose from the allowed profiles |

Every policy can limit `allowedDataBoundaries` and require capabilities.

A locked policy needs `modelId`. A selectable policy may set
`defaultModelId` and `allowedModelIds`.

## Model profile fields

| Field | Meaning |
| --- | --- |
| `id` | Stable profile ID used by policies and requests |
| `label` | User-facing name |
| `provider` | Provider adapter |
| `model` | Provider model name |
| `enabled` | Whether Cloud may resolve the profile |
| `capabilities` | `streaming`, `tools`, `vision`, or an exclusive `transcription` profile |
| `dataBoundary` | `hosted` or `private` |
| `baseURL` | Optional provider endpoint |
| `contextWindow` | Optional context limit |
| `temperature` | Optional profile default |
| `maxOutputTokens` | Optional output limit |
| `pricing` | Optional paired `inputPerMillion` / `outputPerMillion` reference prices |
| `maxLoadedTools` | Deferred tool names retained per conversation; missing, `0`, or negative is unlimited, while a positive value keeps the newest names and evicts the oldest |
| `maxToolRounds` | Tool-using model rounds allowed per chat turn; missing, `0`, or negative is unlimited, while a positive value reserves one additional tool-free model round for the final answer |

Turn deadlines, cancellation, provider failures, and exhausted cost budgets can still
end a chat independently of the tool-round policy.

Model responses sent to the browser omit credentials and private
configuration.

## Restrict a model in Assistant

In the model profile dialog, enable **Restrict use in Assistant** and add the
users, groups, or service accounts that may use it. The permission editor uses
Cloud's normal [access grants](/en/docs/identity/authorization), including
nested group membership. **Use** is the model's read permission.

By default, each profile grants use to authenticated users. Enabling the
restriction removes that general grant. A restricted profile with no grants
is unavailable to everyone, including administrators. Disabling the restriction
restores authenticated access and retains individual grants. Confirm the profile
dialog, then save the settings to apply the changes together. Canceling the
dialog leaves its permissions unchanged. JSON profile exports omit permissions;
importing a new profile gives it the default authenticated access.

Assistant shows only models the caller may use. Direct chat submissions and
message retries enforce the same permission. An explicitly selected model or
Project default that is no longer allowed returns an error; it does not
silently switch providers. When no model was selected, Assistant can choose an
allowed model. If none is available, the composer asks the user to contact an
administrator.

New interactive turns check access again when execution starts or resumes.
Revoking a grant can therefore stop a queued or suspended turn. Already running
provider calls are not canceled by a permission change.

These grants apply only to interactive Assistant chat, including its chat API
and CLI. Background jobs, scheduled chat tasks, workflows, enrichment,
background messages between chats, Vision inspection, and compaction keep their
existing model policies. The restriction does not configure budgets or cost
limits.

## Supported providers

Cloud includes adapters for OpenAI, OpenRouter, Anthropic, Mistral, Gemini,
Ollama, vLLM, and OpenAI-compatible endpoints.

Hosted providers require a credential. Ollama, vLLM, and OpenAI-compatible
profiles can run against private infrastructure.

An OpenAI-compatible profile must set `baseURL`.

## Handle configuration errors

Model resolution fails clearly when:

- AI is disabled;
- the profile JSON is invalid;
- the default profile is missing or disabled;
- a required credential is missing;
- no profile matches the model policy.

Show the returned settings error to an administrator. Do not silently switch to
a model outside the application policy.

Provider credentials are server-side settings. Never pass them to an island or
store them in application data.

## Configure image inspection

`view_image` is available to tool-capable chat models. When the selected model
also supports Vision, it performs the explicit image inspection itself. Set
**Vision tool model** to an enabled profile with the `vision` capability when
tool-capable models without Vision must inspect images too. Cloud does not
silently choose another provider. The selected or configured tool model must
match the application's allowed data boundary; Cloud does not route private
chat data to a hosted fallback.

See [Settings](/en/docs/platform/settings) for runtime configuration and
[Runtime configuration](/en/docs/operations/runtime-configuration) for
deployment responsibilities.

## Configure audio transcription

Create a normal model profile, enable **Audio transcription**, then select it
as the audio model in AI settings (`ai.audio_model_id`). Use `openai` or
`openai-compatible`; the latter requires an explicit base URL supporting
`POST /audio/transcriptions`. Credentials and data boundaries use the same
profile contract as text models.

`transcription` is exclusive: combining it with `streaming`, `tools`, or
`vision` fails validation. Audio profiles cannot serve as the default chat,
background, or workflow model and do not appear in chat model selection.
An empty audio selection disables default audio resolution; Cloud never falls
back to a text model or another provider.

Supported containers depend on the endpoint. Cloud recognizes WAV, MP3/MPEG
audio, FLAC, OGG, M4A/MP4, and WebM, checks their container signatures, and
normalizes the upload filename and MIME type. This does not validate every
codec or convert a recording. A provider can reject a recognized container.
The shared transcription call accepts at most 25,000,000 bytes.

For example, [Scaleway's audio API](https://www.scaleway.com/en/developers/api/generative-apis/audio)
lists WAV, MP3/MPGA, FLAC, and OGG/OGA. Its documented list does not include
M4A/MP4 or WebM. Check the chosen endpoint before promising support for phone
memos or browser recordings.

## Direct-chat allowances

Optional [Assistant limits](/en/docs/ai/usage-and-feedback#set-assistant-budgets)
are configured separately from model access, and are disabled by default.
A quota never grants access to a model. All-model **Unlimited** overrides
model-specific quotas, while finite all-model and model-specific allowances
both apply. Only direct interactive chat calls count; helper inference such
as image inspection, transcription and compaction remains outside the quota.


## Reference prices

Each configured chat model profile can have optional `pricing`:
`{ "inputPerMillion": 0.5, "outputPerMillion": 2 }`. Values use the installation's
shared accounting unit (default `EUR`) per million input/output tokens. Supply
both nonnegative prices, with up to six decimal places, or omit `pricing`.
Explicit zero means free; an omitted price means unpriced and unlimited.
Transcription profiles do not accept token pricing.

The model editor and `cld admin ai models pricing set` update these prices.
Credentials, model permission grants, and pricing remain separate. Each actual
call snapshots its prices, so editing them never rewrites historical costs.
No provider prices or exchange rates are fetched automatically. Configure only
reference prices you want to use across the installation.

A model-specific Assistant budget requires configured prices. Wildcard budgets
and the optional background emergency stop also exclude unpriced models. The
**Assistant limits → Rules** warning lists those models. See
[Usage and feedback](/en/docs/ai/usage-and-feedback) for cost coverage, budgets,
background stops and complete CLI/API operations.
