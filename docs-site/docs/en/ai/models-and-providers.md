---
title: Models and providers
navTitle: Models and providers
section: AI
order: 1020
description: Configure models and providers without exposing credentials to application clients.
tags: [ai, models, providers]
updated: 2026-10-08
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

If a save would leave a model setting without a usable profile, such as
removing the profile that the Vision tool model still uses, or an enabled
profile without its provider key, Cloud keeps the draft and lists each blocking
setting with the profile, the next step, and a link to where you can change it.

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
| `contextWindow` | Optional context limit; Ollama also receives it as `num_ctx` |
| `temperature` | Optional profile default |
| `maxOutputTokens` | Optional output limit |
| `reasoningEffort` | Optional thinking level passed unchanged to chat and tool loops; empty means the model default |
| `extraBody` | Non-secret JSON object of extra provider parameters, at most 8 KiB of UTF-8 JSON; applies to every call on the profile |
| `requestHeaders` | Write-only header patch (`name: string` sets, `name: null` removes); vLLM and OpenAI-compatible chat endpoints only |
| `pricing` | Optional paired `inputPerMillion` / `outputPerMillion` reference prices |
| `maxLoadedTools` | Deferred tool names retained per conversation; missing, `0`, or negative is unlimited, while a positive value keeps the newest names and evicts the oldest |
| `maxToolRounds` | Tool-using model rounds allowed per chat turn; missing, `0`, or negative is unlimited, while a positive value reserves one additional tool-free model round for the final answer |

Turn deadlines, cancellation, provider failures, and exhausted cost budgets can still
end a chat independently of the tool-round policy. Without a limit, a turn still
ends its tool use with an answer when it repeats failing calls or tool searches,
or reaches the last tenth of its run time; see
[Loops within a turn](/en/docs/ai/chat-runtime-and-streaming#loops-within-a-turn).

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

An OpenAI-compatible profile must set `baseURL`. Reasoning models behind such
endpoints stream their thinking as `reasoning`, `reasoning_content`, or
`reasoning_details`; Cloud shows all three as thinking blocks, so a long
reasoning phase is visible progress rather than an idle turn.

## Set the thinking level

In the model profile dialog, set **Thinking level** under **Advanced**, or set
`reasoningEffort` with `cld admin ai models settings set`. The level is a free string of 1–32 lowercase letters, digits, underscores or
hyphens, such as `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`.
Cloud passes it unchanged; the provider decides which values the model accepts.
Omitting it or clearing it preserves the model's default behavior.

| Provider | Request field |
| --- | --- |
| OpenAI, Mistral, vLLM, OpenAI-compatible | `reasoning_effort` |
| OpenRouter | `reasoning.effort` |
| Anthropic | `output_config.effort` with adaptive thinking; `none` disables thinking |
| Gemini | `generationConfig.thinkingConfig.thinkingLevel`; `none` sets a zero thinking budget |
| Ollama | `think`; `none` maps to `false` |

The profile level applies to chat and tool loops, including background agents,
scheduled chat tasks and workflow chat actions. Structured calls, including
titles, summaries and workflow calculations, and context compaction request
`reasoningEffort: "none"` for every provider. Choose models that support disabling
reasoning for those tasks. Unsupported levels produce provider errors; Gemini 3
cannot fully disable thinking, and some Anthropic models reject `none`.

Without an explicit output limit, Anthropic uses 8,192 output tokens, including
thinking tokens. Cloud uses that same default for budget reservations. Set
`maxOutputTokens` when a different limit is needed.

## Add provider parameters

The profile dialog edits extra parameters and headers under **Advanced** →
**Request options**. Use `extraBody` for provider features outside Cloud's profile fields. It must be
a plain JSON object with at most 8,192 bytes when serialized as UTF-8 JSON.
It applies to **every call** on the profile, including structured output, titles,
summaries and compaction. Provider parameters merge last and may override the
helper calls' reasoning behavior. For example:

```json
{"chat_template_kwargs":{"enable_thinking":false}}
```

For a Gemini 2.5 model that accepts a thinking budget:

```json
{"generationConfig":{"thinkingConfig":{"thinkingBudget":1024}}}
```

Cloud rejects these top-level keys because it owns their meaning:

- Content and model: `model`, `messages`, `system`, `contents`, `systemInstruction`,
  plus `models` and `route`, which select other models.
- Tools and loop control: `tools`, `tool_choice`, `toolConfig`,
  `parallel_tool_calls`, `stream`, `stream_options`.
- Structured output: `response_format`, `structured_outputs`, `format`.
- Profile generation settings: `temperature`, `max_tokens`,
  `max_completion_tokens`, `reasoning_effort`, `reasoning` and `n` (number of answers).

Use `reasoningEffort` for the thinking level. Nested provider options remain
available, including `thinking`, `output_config`, `chat_template_kwargs`,
`generationConfig`, `options` and `think`. Cloud also reserves
`generationConfig.responseSchema`, `generationConfig.responseJsonSchema`,
`generationConfig.responseMimeType`, `generationConfig.temperature`,
`generationConfig.maxOutputTokens`, `generationConfig.candidateCount`,
`output_config.format`, `options.temperature` and `options.num_predict`. The
three containers `generationConfig`, `output_config` and `options` must be
objects so they cannot replace Cloud's output schema or token limits. Keys named
`__proto__`, `constructor` or `prototype` are rejected at every depth. Cloud
compares parameter names without regard to case or underscores, so
`generation_config.max_output_tokens` counts as `generationConfig.maxOutputTokens`.

## Add private endpoint headers

Extra HTTP headers are supported only for vLLM and OpenAI-compatible chat
profiles. They are encrypted using the installation's settings encryption key
and remain server-side. Admin reads return `requestHeaderNames`; header values
never return to the browser or CLI.

Submit `requestHeaders` as a patch: a string sets or replaces a header, `null`
removes it, and omitted names keep their stored values. Saving a profile without
`requestHeaders` keeps all its headers. `--clear-headers` removes every stored
header before applying any supplied patch. Deleting a profile prunes its headers;
changing its provider discards them, consistently with provider credentials.

Names are case-insensitive HTTP tokens of at most 128 characters. Duplicate names
are rejected, as are `content-type`, `content-length`, `host`, `connection` and
`transfer-encoding`. At most 32 headers may be configured; each value may contain
at most 4,096 printable ASCII characters, spaces or tabs.

`Authorization` is allowed. When the profile has an API key, nessi replaces the
custom Authorization header with `Bearer <API key>`. Use a protected JSON file
or standard input to avoid putting header secrets in shell history:

```bash
cld admin ai models settings get --id MODEL_ID --json
cld admin ai models settings set --id MODEL_ID --thinking-level low --yes --json
cld admin ai models settings set --id MODEL_ID --extra-body-file parameters.json --yes --json
cld admin ai models settings set --id MODEL_ID --headers-file headers.json --yes --json
cld admin ai models settings set --id MODEL_ID --headers-stdin --yes --json < headers.json
cld admin ai models settings set --id MODEL_ID --clear-thinking-level --clear-extra-body --clear-headers --yes --json
```

`headers.json` is an object of names to string values or `null`, for example
`{"X-Endpoint-Token":"secret","X-Obsolete":null}`. `parameters.json` contains the
extra parameters object. `--stdin` reads extra parameters; `--headers-stdin`
reads a header patch. These separate flags let one command take both inputs.
Commands read the current revision before writing and report a conflict when
another administrator changed the configuration; read it again before retrying.

Administrators can also use `GET` and `PUT`
`/api/admin/core/ai-quotas/models/{id}/settings`. GET returns
`{id, reasoningEffort, extraBody, requestHeaderNames, revision}`. PUT requires
`expected: revision` and accepts any of `reasoningEffort` (string or `null`),
`extraBody` (object or `null`), `requestHeaders` (patch) and
`clearRequestHeaders: true`. Omitted fields keep their values. Validation errors
return 400; stale revisions return 409. Transcription profiles reject thinking
levels, extra parameters and extra headers.

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
