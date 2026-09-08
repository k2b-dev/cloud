---
title: Models and providers
navTitle: Models and providers
section: AI
order: 1020
description: Configure models and providers without exposing credentials to application clients.
tags: [ai, models, providers]
updated: 2026-09-05
---

# Models and providers

Administrators configure model profiles. Applications select them through a
policy.

A profile names the provider and model. It also records capabilities and the
data boundary used for policy checks.

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
| `capabilities` | `streaming`, `tools`, or `vision` |
| `dataBoundary` | `hosted` or `private` |
| `baseURL` | Optional provider endpoint |
| `contextWindow` | Optional context limit |
| `temperature` | Optional profile default |
| `maxOutputTokens` | Optional output limit |
| `maxLoadedTools` | Deferred tool names retained per conversation; missing, `0`, or negative is unlimited, while a positive value keeps the newest names and evicts the oldest |
| `maxToolRounds` | Tool-using model rounds allowed per chat turn; missing, `0`, or negative is unlimited, while a positive value reserves one additional tool-free model round for the final answer |

Turn deadlines, cancellation, provider failures, and exhausted credits can still
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
