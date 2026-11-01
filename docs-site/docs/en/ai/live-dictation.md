---
title: Live dictation
section: AI
order: 1060
description: Stream speech into an application's draft with shared authorization, limits, and cancellation.
tags: [ai, audio, dictation, browser]
updated: 2026-11-01
---

# Live dictation

Live dictation turns microphone audio into text while a person speaks. Core
provides one endpoint for built-in and third-party applications. The application
chooses where to insert the text and when to save its draft.

## Check availability on the server

```ts
import { getLiveDictationStatus } from "@k2b/cloud/ai";

const status = await getLiveDictationStatus(c.get("accessSubject"));
// Pass status.available to the application's island with its initial data.
```

The helper returns `{ available: boolean, reason?: "not_configured" |
"no_access" | "disabled" }`. It checks AI enablement, the `liveAudio` slot,
the enabled provider/model, and the person's access to the owning model ID.
It opens no microphone or provider connection and reserves no capacity.
`GET /api/ai/dictation/status` returns the same shape for browser sessions.

An application renders its microphone from this authorized SSR snapshot. The
socket repeats the check when starting and every 30 seconds. Availability does
not promise remaining daily allowance or free capacity.

## Start a browser session

```ts
import { createLiveDictationSource } from "@k2b/cloud/ai/browser";

const source = createLiveDictationSource({ app: "my-app" });
const controller = new AbortController();
const session = source.start({ signal: controller.signal });

for await (const event of session.events) {
  if (event.type === "text") appendToDraft(event.text);
  if (event.type === "error") showDictationError(event);
}
```

`start({ deviceId?, signal })` returns immediately with:

- `events: AsyncIterable<DictationEvent>`;
- `stop(): Promise<void>`, which waits for final words and a terminal event.

The event types are exported alongside `DictationSource`, `DictationSession`,
`DictationDevice`, and `DictationErrorCode` from the browser entry point:

| Event | Meaning |
| --- | --- |
| `state: connecting` | Requesting microphone access and opening the connection |
| `state: live, maxMs, device?` | Ready; device contains the actual track ID and label |
| `level, level: number` | RMS level between 0 and 1, about every 100 ms |
| `text, text: string` | Append this delta; previously delivered text never changes |
| `state: finishing` | Microphone stopped; waiting for final words |
| `state: finished, reason?` | Complete; reason can be `max_duration`, `silence`, or `daily_limit` |
| `error, code, retryable, resetsAt?` | Session ended; preserve text already received and offer an explicit recovery action |

Call `await session.stop()` for a regular stop. It ends audio normally so the
model can commit its final words. Cloud waits at most five seconds, then returns
the text received so far. If the model's final text revises the streamed text,
Cloud finishes successfully with the text already delivered. Abort the start
signal to discard or leave: microphone and connection close immediately and
the iterable ends silently. `pagehide` also cancels. There is no automatic
reconnect, replay, or correction pass.

`await source.devices()` lists microphone IDs and labels; labels may be empty
before permission. Pass a selected `deviceId` to `start`. A missing or vanished
selection falls back to the system default. The host owns device preferences.
Audio uses one channel, echo cancellation, noise suppression, and the browser's
default AudioContext sample rate. An AudioWorklet resamples linearly to 16 kHz
and emits 100 ms PCM16 frames.

Microphone permission failures map to `microphone_blocked` (retryable);
unavailable or unreadable microphones map to `microphone_unavailable`.
A socket closing without a final result maps to retryable `connection_lost`,
except close code 1008: its recognized error reason becomes a non-retryable
error of that code; an unknown reason becomes non-retryable `connection_lost`.

## WebSocket protocol

Connect to `/api/ai/dictation/live` on Cloud's origin using a browser session.
An Origin header equal to Cloud's public origin is required. Model grants and
Core application access apply. The `app` identifier records usage attribution;
it does not grant access.

Send exactly one `{"type":"start","app":"my-app"}` within five seconds of
opening. Wait for `{"type":"ready","maxMs":600000}`, then send binary mono
PCM16 little-endian audio at 16 kHz. A 100 ms frame is 3200 bytes; each frame
must contain whole samples and be at most 16 KiB. End with `{"type":"stop"}`.
Unknown controls, duplicate starts, or audio before ready end the socket with
close code 1008. This includes audio sent after `start` while the model is
still connecting.

Server messages are:

```ts
type ServerEvent =
  | { type: "ready"; maxMs: 600000 }
  | { type: "delta"; text: string }
  | { type: "warning"; code: "time_left"; ms: number }
  | { type: "finishing" }
  | { type: "done"; text: string; audioMs: number; reason?: "max_duration" | "silence" | "daily_limit" }
  | { type: "error"; code: string; retryable: boolean; resetsAt?: string };
```

Errors use `not_configured`, `no_access`, `daily_limit`, `overloaded`,
`busy_elsewhere`, `max_duration`, `silence`, `provider_failed`, or
`connection_lost`. A daily-limit rejection includes `resetsAt`, an ISO timestamp
for the installation's next local midnight. Duration, silence, and daily limits
reached during dictation finish normally with a reason and preserve the text.
Terminal refusals send an error and close with 1008 and that error code.

## Limits and recovery

Each person may run one session across all apps, tabs, and Core replicas.
A second start receives `busy_elsewhere`; it cannot take over the session.
Installation-wide concurrency defaults to four. A full installation or more
than two seconds of queued provider audio returns `overloaded`.

A session lasts at most ten minutes, with one time-left warning at minute nine.
Two minutes of silence below -50 dBFS, including an idle microphone connection,
stop it. Incoming audio is limited to 32,000 bytes per second with a two-second
burst. Cloud bounds its in-memory PCM queue to two seconds too. The model must
establish its realtime session within five seconds.

The separate daily allowance defaults to 60 minutes per person, resets at local
midnight in the installation's time zone, and is checked before start and on
every charge at the five-second heartbeat while running. It measures active
session seconds, including pauses. It does not consume the chat token allowance.
The usage administration shows audio minutes grouped by person and app.

Session revocation, model access loss, lease loss, disconnect, or Core shutdown
abort the model connection. After an interruption, start another dictation
explicitly. Words still in transit may be missing.

## Privacy

Cloud holds audio only in memory on its way from the browser to the speech
model. It stores neither audio nor transcript and logs no content. Accounting
keeps metadata: person, app, model, duration, and audio duration. The host app
may save inserted text as ordinary draft text. The speech provider's own
retention policy remains the operator's responsibility.

Discarding a session records a normal end with cancellation metadata. Dictation
runs do not add turns to the chat usage timeline.

Public notebook pages do not receive live dictation. This API does not replace
or alter Assistant's existing recording storage path.

Operators configure the model and limits in
[Runtime configuration](/en/docs/operations/runtime-configuration#live-dictation).
