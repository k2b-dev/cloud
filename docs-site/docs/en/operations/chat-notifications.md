---
title: Chat notifications
navTitle: Chat notifications
section: Operations
order: 1076
description: Configure Chat push content and inspect delivery workers and badge counts.
tags: [chat, notifications, browser, operations]
updated: 2026-10-28
---

# Chat notifications

Chat uses Cloud's [browser notification delivery](/en/docs/platform/notifications#browser-delivery).
Configure the installation's public origin and HTTPS, deploy Core and Chat
with the same platform contract, and register a browser endpoint before testing.
An unsupported Badging API does not prevent notifications.

## Choose notification content

The administrator setting `chat.push_preview` defaults to `true`. It includes
the beginning of the message in the browser notification, including on a locked
screen and paired devices. Turn it off to show the chat name and sender only.
The setting applies to everyone and also removes message text from email.
Already prepared notifications keep the content they had when sent. Messages
use the recipient's last interactive Chat read locale, or the operator's
`app.locale` default when none is stored.

Cloud's notification preferences expose three Chat kinds:

- `chat.mention`: mentions and replies; browser recommended, email selectable.
- `chat.message`: new messages in chats whose effective level is **All messages**;
  browser recommended, email unavailable with an explanation.
- `chat.added`: another person adds the recipient to a chat or channel;
  browser recommended, email selectable. Creating a chat does not notify its creator.

A chat's **Off** level blocks message and personal pushes until it expires.
Cloud's do not disturb and quiet hours suppress browser delivery without a
catch-up notification. Service accounts never receive pushes.

## Check delivery

Chat commits a notification outbox row with each completed message or membership
addition. The `chat:delivery` job advances a durable recipient cursor in batches
of 500. The `chat:push` job coalesces each person/chat pair and waits three seconds
from the first candidate. Reading before that job runs suppresses its notification
on every device. Current access and notification level are checked again before
content is sent to Cloud.

The browser group is the exact public conversation ID, including for messages
in threads. Destinations use `/app/chat/c/<chat>/m/<message>` or
`/app/chat/c/<chat>/t/<thread>/m/<message>`. Later unread messages replace that
chat's notification quietly. Personal notifications or reading since the last
push can alert again; mentions and replies bypass the rolling limit of one alert per person
per ten seconds.

The jobs use Sync's default bounded retention: seven days and 256 maximum-size
messages' worth of bytes per stream. At capacity JetStream drops the oldest
pending work. Unread counters remain in Postgres. Cloud discovers the two jobs
in its standard administrative Sync controls, including queue depth and dead
letters. Inspect the `chat:notification-outbox` log source for publication retries.

The additive startup migration creates `chat.notification_outbox`,
`chat.notification_pending`, and `chat.notification_push_state`. Last push
sequence and time survive process restarts. No environment variable is added.

Push notifications currently cover ordinary chats and channels. System-chat
push notifications are not available in this slice.

## Check the badge

`GET /api/chat/badge` returns `{ "count": number }` for the signed-in person.
The same function supplies push badges and the navigation badge. It adds chats
with effective **All messages** and unread content to the existing unread
mentions/replies count. Each component is capped at 99; permission checks and
bounded candidate scans can undercount inaccessible or very large collections.
Service-account credentials receive zero.

Read state is authoritative in Postgres. The browser closes a local group with
`closeGroup("chat", conversation.id)` and refreshes the count after reading;
a push accepted by the browser vendor cannot be recalled remotely.
