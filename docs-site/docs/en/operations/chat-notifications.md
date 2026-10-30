---
title: Chat notifications
navTitle: Chat notifications
section: Operations
order: 1076
description: Configure Chat push content and inspect delivery workers and badge counts.
tags: [chat, notifications, browser, operations]
updated: 2026-10-29
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

- `chat.mention`: mentions, replies, and followed item discussions; browser recommended, email selectable.
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

## Enable resource discussion notifications after the upgrade

Update Core first, then deploy Chat and the discussion providers. Chat declares
`platformPermissions: ["resources:readers"]` and receives its workload credential
automatically. There is no Chat credential to create or environment variable to
add. Deployment of Chat's declaration admits the reader checks, as described in
[App-to-app reader checks](/en/docs/platform/app-to-app-queries).

A provider offers the `discussions` role and `access.readable` on its resource
Types. The same path works for built-in and third-party providers. Following an
item discussion selects its incoming messages for push; mentions and replies
also qualify. The conversation's notification level still applies.

Chat asks the platform about the item and its expected container, using only
current participants of that conversation or followers of that thread. An item
moved to another container is no longer readable through the old conversation.
Chat checks during recipient preparation and again before the final send.
Every prepared decision expires after three seconds; lock waits are bounded.
Owner checks run outside Chat database transactions.

- A checked result keeps only the readable recipients. A rejection drops the
  recipient without retrying.
- A temporary failure omits the item from counts and retries delivery through
  the existing job. An earlier positive decision cannot authorize the push.
- `not_configured` suppresses push until setup is complete. **Administration →
  Chat** shows the last actual check's state, resource type, time and reason,
  such as a missing reader function, automatic credential or Core admission.
  Before any check it says **Not checked yet**.

System-chat pushes never include a “+n more” count, because coalesced messages
can belong to different resources. Chat checks both the chosen personal message
and the newest message when they belong to different item discussions.
Cloud cannot recall a push after accepting it; later revocation still blocks
opening the resource.

## Check the badge

`GET /api/chat/badge` returns `{ "count": number }` for the signed-in person.
The same function supplies push badges and the navigation badge. It adds chats
with effective **All messages** and unread content to the existing unread
mentions/replies count. Each component is capped at 99; permission checks and
bounded candidate scans can undercount inaccessible or very large collections.
Service-account credentials receive zero. System-chat mention and reply
counts use the same item reader check. Interactive decisions, including denials,
may be reused for at most 60 seconds. Each person can trigger at most 100 new
checks per 60 seconds, and all interactive traffic shares a limit of 500.
Overlapping requests share a cache reservation. These limits leave at least
1,001 of Core's 1,501 reader requests per minute outside interactive traffic;
delivery always checks freshly. Push jobs reuse only cached count decisions,
so their badges never spend the interactive reader budget. Cached-only count reads inside a database
snapshot omit decisions that were not prepared before entering it.

Read state is authoritative in Postgres. The browser closes a local group with
`closeGroup("chat", conversation.id)` and refreshes the count after reading;
a push accepted by the browser vendor cannot be recalled remotely.
