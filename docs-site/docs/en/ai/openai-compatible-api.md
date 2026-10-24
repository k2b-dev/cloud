---
title: OpenAI-compatible API
navTitle: OpenAI-compatible API
section: AI
order: 1025
description: Connect external text clients to your allowed Assistant models with a models-only API key.
tags: [ai, models, api, authentication, streaming]
updated: 2026-10-23
---

# OpenAI-compatible API

Use an external text client, such as a dictation app that cleans up transcripts,
with the Assistant models you may already use. Only the client's messages reach
the provider. This API has no Cloud tools, chats, files, memory, personalization,
projects or global instructions. For Assistant with tools, use the
[Cloud CLI](/en/docs/platform/cli-modules).

## Connect a client

An administrator must enable **OpenAI-compatible API** in AI settings
(`ai.openai_api_enabled`, off by default). You also need
[access to a chat model](/en/docs/ai/models-and-providers#restrict-a-model-in-assistant).

In your profile under **Developer → API keys**, create a key with the access
**AI models only**, or run:

```bash
cld account api-keys create "Transcript cleanup" --access models
```

Store the token when it is shown; Cloud returns it only once.
**Assistant settings → API access** shows the base URL and your model IDs.
Configure the client with:

| Field | Value |
| --- | --- |
| Base URL | `https://<your-cloud>/api/ai/openai/v1` |
| API key | Your models-only key |
| Model | A profile ID from `GET /models` |

Send the key as `Authorization: Bearer <key>`. Full-access personal keys,
sessions and OAuth tokens are refused here. Listing models returns only allowed
chat profiles, with `id`, `object: "model"`, `created: 0` and
`owned_by: "cloud"`. Transcription profiles, prices, provider details and data
boundaries are omitted.

Replace `<your-cloud>` and `MODEL_PROFILE_ID`. With the key already loaded
into `CLOUD_MODELS_KEY` from your secret store:

```bash
curl 'https://<your-cloud>/api/ai/openai/v1/chat/completions' \
  -H @- \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL_PROFILE_ID","messages":[{"role":"user","content":"Clean up this transcript: um, the meeting starts at ten."}]}' <<EOF
Authorization: Bearer $CLOUD_MODELS_KEY
EOF
```

## Connect a machine account

Administrators can create a models-only key for an active standalone account
or agent in **Accounts → Service accounts → Create API key**. Select the account
by name, choose **AI models only**, and save the key when it appears. The
creation dialog also offers **Full access** for ordinary Cloud API clients.
A full-access key cannot call this Models API.

First create the [service account](/en/docs/identity/service-accounts), then
grant it access to the model in **AI settings**. A machine uses its own grants,
including any explicitly configured group or authenticated grants. Its creator's
permissions do not contribute. An account with no matching model grant sees no
models and cannot generate a completion.

The administrator API accepts the same purpose:

```http
POST /api/admin/identity/service-accounts/<id>/api-keys
Content-Type: application/json

{"name":"Transcript cleanup","access":"models"}
```

`access` is `full` by default. `models` cannot be combined with ordinary
credential scopes. The returned token appears only in this creation response;
metadata and revocation remain in Accounts. Use the same base URL and model
IDs as for a personal key. OAuth access tokens cannot call this API.

## Request fields

`POST /chat/completions` accepts JSON. It generates one text answer.

| Supported field | Behavior |
| --- | --- |
| `model` | Required allowed model profile ID |
| `messages` | Required non-empty array; text only |
| `temperature` | 0–2; omitted uses the profile/provider default |
| `top_p` | 0–1; forwarded in the provider's parameter format |
| `max_tokens`, `max_completion_tokens` | Positive integers; `max_completion_tokens` wins |
| `stream` | Boolean, default `false` |
| `stream_options.include_usage` | Include reported usage at the end of a stream |

Message content is a string or an array of `{"type":"text","text":"..."}`
parts, joined without a separator. `system` and `developer` messages become
the request system prompt, in order, separated by a blank line. `user` and
`assistant` messages retain their roles. Cloud adds no instructions.
The model profile's thinking level still applies; thinking output is omitted.

Unknown fields are ignored. These include `stop`, `seed`, `presence_penalty`,
`frequency_penalty`, `logprobs`, `user`, `thinking`, `enable_thinking`,
`chat_template_kwargs`, `top_k`, `reasoning_effort`, `metadata`, `store`,
`tool_choice` and `parallel_tool_calls`. They are not forwarded to the provider.

The following requests return 400:

| Rejected input | Error code |
| --- | --- |
| Non-empty `tools` or `functions` | `unsupported_parameter` |
| `n` other than 1 | `unsupported_parameter` |
| `response_format.type` other than `text` | `unsupported_parameter` |
| Any `audio` field, or `audio` in `modalities` | `unsupported_parameter` |
| `tool` or `function` message roles; assistant `tool_calls` or `function_call` | `unsupported_content` |
| Image, audio, file or other non-text content parts | `unsupported_content` |

Empty tool/function arrays, `n: 1`, `response_format: {"type":"text"}` and
`null` for any optional field are accepted.

## Responses and streaming

A normal response has `object: "chat.completion"`, the selected profile ID
as `model`, and one assistant message in `choices`. `finish_reason` is
`length` when the output limit was reached, otherwise `stop`.
`usage` contains `prompt_tokens`, `completion_tokens` and `total_tokens`
only when the provider reported them.

With `stream: true`, the response is Server-Sent Events. Each event is
`data: <json>\n\n`, without an `event:` line. Chunks use
`object: "chat.completion.chunk"`. The sequence is:

1. An assistant role delta with empty content.
2. Text deltas; thinking and tool blocks are omitted.
3. An empty delta with the final `finish_reason`.
4. If requested and reported, a usage chunk with `choices: []`.
5. `data: [DONE]\n\n`.

While the stream is open, Cloud sends the SSE comment line `: keepalive` every
5 seconds so that idle connections stay open. OpenAI clients ignore comment
lines.

Quota rejection and provider failure before the first text arrive as HTTP JSON
errors. A provider failure after text arrives as one `data: {"error": {...}}`
event; the stream then closes without `[DONE]`. Cloud keeps the request open
while the provider makes progress. With and without streaming, a provider that
sends nothing for 60 seconds before or during its answer fails the request with
`upstream_error`. The gateway waits at most 4 minutes for response headers, so
a non-streaming answer must be complete within that time. Use `stream: true`
for longer answers. Client disconnection cancels the provider call. Missing
usage after cancellation is booked as an estimate through the
normal inference accounting.

## Limits and usage

Requests use the authenticated account's model grants and chat allowance.
Personal keys also retain account category and expiry checks. Machine usage
belongs to the service account, across all its keys. The inference ledger
records the credential ID and attributes each call to task `openai-api`.
No request or response content is stored in the inference ledger.

- **Output:** the requested output limit is capped by the model profile's
  `maxOutputTokens` and the remaining priced chat budget.
- **Context:** estimated input must fit the provider's context window.
- **Body size:** 16 bytes times the largest context window among your allowed
  chat models. The estimate assumes about four characters per token and up to
  four UTF-8 bytes per character. A profile with no explicit window counts as
  1,000,000 tokens, the largest supported adapter default.
- **Rate:** the existing `security.rate_limit_per_second` limit applies per IP.
- **Concurrency:** `ai.openai_api_max_concurrent_requests` defaults to four
  simultaneous requests per account across all instances. Typical clients use
  one or two connections. Four leaves room for a second client while limiting
  scripts that would crowd out other accounts. A Cloud process runs up to eight
  queued chat turns; these synchronous requests bypass that queue. Operators
  with more provider capacity can raise the limit to 64.

A request takes its slot after authentication, before Cloud reads the request
body, and holds it until the response ends; a request that is then rejected
releases it at once. Slots refresh every 30 seconds and expire after two
minutes if a process crashes. A concurrency refusal returns `Retry-After: 1`.
The limit relies on Valkey: if Valkey is unreachable for more than two minutes,
running requests lose their slots but continue, so the limit is best-effort
until they end.

**Models without reference prices have no usage limit.** As in Assistant, chat
allowances do not cover them. Only rate and concurrency limits protect their
use through this API. See [Usage and feedback](/en/docs/ai/usage-and-feedback).

## Errors

All errors use `{"error":{"message":"...","type":"...","param":null,"code":"..."}}`.
Messages follow the request locale (English or German); codes and types remain
stable. `param` names the offending field when applicable.

| Status | Type | Code |
| --- | --- | --- |
| 400 | `invalid_request_error` | `invalid_request`, `unsupported_parameter`, `unsupported_content`, `context_length_exceeded` |
| 401 | `authentication_error` | `invalid_api_key` |
| 403 | `permission_error` | `openai_api_disabled`, `ai_disabled`, `model_access_denied` |
| 404 | `invalid_request_error` | `model_not_found`, `not_found` |
| 413 | `invalid_request_error` | `request_too_large` |
| 429 | `insufficient_quota` | `insufficient_quota` |
| 429 | `rate_limit_error` | `rate_limit_exceeded`, `too_many_concurrent_requests` |
| 502 | `api_error` | `upstream_error`, `missing_provider_credential` |
| 500 | `api_error` | `internal_error` |

A request for a model you cannot use returns `404 model_not_found`. This
covers unknown models, models without your grant, models whose provider has no
credential, and AI turned off. `ai_disabled`, `model_access_denied` and
`missing_provider_credential` appear only when an administrator changes these
settings during the request.

## Key isolation and revocation

Models-only keys carry the reserved `ai:inference` purpose. Personal key
creation and administrator creation for standalone accounts or agents issue it
through `access: "models"`. The Models API accepts exactly that purpose, with
no other scopes. Resource-bound credentials cannot receive it.
Central authentication rejects it on every other Cloud surface; only this
endpoint authenticates it directly. Other scopes alongside it do not bypass
the rejection. Its secret is stored with a separate hash, so applications on
an older `@k2b/cloud` version, which do not know the scope, reject the key
instead of granting full access.

Revoke the key like any personal key in your profile or with
`cld account api-keys revoke <id-or-prefix-or-name> --yes`.
For machines, revoke the key in Accounts or disable its service account.
Credential revocation, expiry, account disable, and model grant removal affect
the next request. Cloud rechecks the credential and model grant immediately
before provider dispatch, after quota admission; rejected dispatch releases
its reservation without charging inference usage.

Turning off `ai.openai_api_enabled` stops new requests with existing keys too.
It does not cancel provider calls already running.
