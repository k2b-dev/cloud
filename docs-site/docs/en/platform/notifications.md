---
title: Notifications
navTitle: Notifications
section: Platform services
order: 530
description: Define, send, and inspect typed notifications.
tags: [notifications, email, browser]
updated: 2026-10-08
---

# Notifications

Define each notification once. Then send it with typed data.

The definition gives Cloud enough information to validate the event, resolve
the recipient, apply notification preferences, choose delivery channels, and
record the result.

Cloud stores the event and handles delivery, fallback, retries, and history.
The application still decides when the domain event has happened.

> A notification does not grant permission. Authorize the domain change before
> sending it. See [Resource authorization](/en/docs/identity/authorization).

## Notification model

A definition gives the event a stable ID such as `inventory.stockLow`. It
defines:

- who can receive it;
- which payload is valid;
- what the recipient sees;
- which delivery channels are recommended or required.

The send API accepts the bound definition. It does not accept an arbitrary
event name.

| The application owns | Cloud owns |
| --- | --- |
| The domain event and when it has committed | Recipient resolution and user preferences |
| The payload schema and presentation | Event and delivery persistence |
| Whether a channel is recommended or required | Channel selection, fallback, and retries |
| Authorization for the operation that caused the event | Delivery history and operational status |

A notification reports a domain change. The domain database remains the source
of truth.

## Define a notification

A definition describes one notification event. Keep definitions in one small
application module.

```ts
import { notification } from "@k2b/cloud";
import { z } from "zod";

export const NOTIFICATIONS = {
  stockLow: notification({
    recipient: "user",
    label: "Low stock",
    description: "Warns inventory owners when an item falls below its threshold.",
    presentation: {
      baseLocale: "en",
      translations: {
        de: {
          label: "Niedriger Bestand",
          description: "Warnt Verantwortliche, wenn der Bestand eines Artikels den Grenzwert unterschreitet.",
        },
      },
    },
    data: z.object({
      itemId: z.string(),
      itemName: z.string(),
      remaining: z.number().int().nonnegative(),
    }),
    delivery: {
      recommended: ["browser", "email"],
    },
    render: ({ itemId, itemName, remaining }, { locale }) => ({
      title: `${itemName} is running low`,
      body: `${remaining} units remain.`,
      targetHref: `/app/inventory/items/${encodeURIComponent(itemId)}`,
    }),
    email: ({ itemName, remaining }, { locale }) => ({
      subject: `${itemName} is running low`,
      content: `${remaining} units remain.`,
    }),
  }),
};
```

The Zod schema provides the TypeScript type. Cloud also uses it to validate
data at runtime.

### Set the definition options

| Option | Required | Contract |
| --- | --- | --- |
| `recipient` | Yes | `"user"` or `"email"`; fixes the address shape used by `send()` |
| `label` | Yes | Non-empty name used by preference and operations surfaces |
| `description` | Yes | Non-empty explanation of when the application emits the event |
| `presentation` | No | Localized overlays for `label` and `description` |
| `data` | Yes | Zod schema used for type inference and runtime parsing |
| `delivery.recommended` | No | Ordered, preference-aware channels; defaults to `[]` |
| `delivery.required` | No | Channels that cannot be disabled; defaults to `[]` |
| `render` | Yes | Builds the channel-neutral presentation |
| `email` | No | Builds an email-specific presentation when email is selected |

`label` and `description` cannot be empty.

When `presentation` is present, the complete `label` and `description`
declaration belongs to `presentation.baseLocale`. Add partial overlays under
`presentation.translations`. Cloud canonicalizes BCP 47 locale keys and
resolves an exact locale, then its language ancestors, then the base
declaration. For example, `de-CH` uses a `de` overlay when no `de-CH` overlay
exists. Notification preferences and delivery history receive this
request-scoped presentation; stable definition IDs and keys do not change.

Channel names cannot be duplicated within a delivery list or appear in both
lists. An email-recipient definition must include `email` in
`delivery.required`.

`render` and `email` can also return a Promise.

### Render the content

Follow [Product language and tone](/en/docs/build/product-language-and-tone)
for notification titles, bodies, actions, and email subjects in English and
German.

`render()` receives the parsed payload and a context containing the canonical
`locale` selected for this notification. `email()` receives the same context.
Use it to resolve final text and value formatting without adding locale to the
domain payload schema. `render()` returns:

| Field | Required | Constraint |
| --- | --- | --- |
| `title` | Yes | Trimmed, non-empty, and at most 200 characters |
| `body` | No | Trimmed and at most 4,000 characters; an empty body is omitted |
| `targetHref` | No | Canonical same-origin absolute path beginning with `/` |
| `group` | No | Stable browser group key: 1–128 characters matching `^[A-Za-z0-9._:-]+$`, with no whitespace; grouping requires an application ID that starts with a lowercase letter and contains only lowercase letters, digits, and hyphens |
| `badge` | No | Non-negative safe integer for the app badge; `0` clears it |

`targetHref` must point to a route on the same Cloud origin. External URLs are
rejected.

Keep sensitive details on the destination page. That page must check access.

When `email()` is present, it returns:

| Field | Required | Meaning |
| --- | --- | --- |
| `subject` | Yes | Email subject |
| `content` | No | Plain-text content |
| `rawHtml` | No | HTML content |

Cloud sanitizes the body and wraps it in the installation's HTML frame. It
also sends a plain-text part: sanitized `content` when supplied, otherwise text
derived from `rawHtml`. Email goes through [Outgoing mail](/en/docs/platform/outgoing-mail)
on the default sender profile as app `core`, with a stable key for each delivery.

Without `email()`, Cloud uses the neutral `title` as the subject and `body` as
the plain-text content.

### Register the definition

```ts
import { defineApp } from "@k2b/cloud";
import { NOTIFICATIONS } from "./notifications";

export const app = defineApp({
  id: "inventory",
  // ...
  notifications: NOTIFICATIONS,
});
```

Definition keys use lower camel case, such as `stockLow`. `defineApp()` combines
the application ID and key into `inventory.stockLow`. The bound, typed
definition is available as `app.notifications.stockLow`.

Cloud registers the metadata when the application starts. Schemas and rendering
functions stay inside the application.

Removing a definition makes it inactive after the next registration.

## Choose a recipient

The recipient determines the address accepted by `send()`.

| Recipient | Send with | Use for |
| --- | --- | --- |
| `user` | `{ userId }` | Product notifications for an existing Cloud user |
| `email` | `{ email }` | Invitations or messages for someone without a Cloud account |

A user recipient must exist in Cloud. Cloud resolves the user's registered
email address and browser endpoints when the event is sent.

A direct email address is normalized and validated before Cloud creates the
event.

Email recipients must require the `email` channel. They have no Cloud account
with notification preferences.

## Choose delivery channels

The delivery policy determines how Cloud sends the notification.

```ts
delivery: {
  recommended: ["browser", "email"],
  required: [],
}
```

| Policy | Selection | Timing | Failure |
| --- | --- | --- | --- |
| `recommended` | User preferences replace the ordered defaults | The first selected channel is queued; later choices are fallbacks | Cloud activates the next choice |
| `required` | The user cannot disable the channel | Every required delivery is processed as part of `send()` | Missing or failed required delivery makes the result an error |

Use required delivery only when the channel is part of the protocol. Ordinary
product updates should normally be recommended so the recipient controls how
they arrive.

A required channel can still be unavailable. Cloud returns an error summary
when it has no driver or destination.

### Browser delivery

The browser channel uses Web Push exclusively. It needs a user with an active
browser endpoint and notification permission. Each registered endpoint gets
its own delivery.

The service worker shows an operating-system notification whether Cloud is
visible, in the background, or has no open tab. An already-open destination
does not suppress the notification. Multiple tabs in the same browser profile
do not create extra deliveries. Browser and operating-system settings control
when and how notifications appear.

Notifications show the rendered title and Cloud icon. The presentation body
stays out of the push payload. Clicking a notification opens or focuses its
Cloud destination, where normal authentication and authorization apply.

Set `group` in `render()` to replace notifications for the same subject on each
device. Cloud prefixes the key with the application's ID: `inventory` and
`group: "stock:item-42"` use the tag `inventory:stock:item-42`. Other
applications cannot collide with that tag. Each new notification in the group
replaces the previous one and requests a fresh alert with `renotify: true`;
the browser and operating system control the alert. The push topic stays per
event, so the push service cannot link pushes by group and an offline device
receives each push when it reconnects. If an older notification arrives after
a newer one in the same group, for example after a delivery retry, the device
keeps the newer notification without a new alert. Without `group`, notifications
keep their event ID as the tag.

Set `badge` to the application's current unread count. A positive count calls
the Badging API; `0` clears the badge. Omitting it leaves the badge unchanged.
The device applies a badge only when it was rendered at or after the last badge
it applied. Badge support is optional: unsupported browsers and rejected badge
requests silently leave it absent or unchanged, and the notification still appears.
The badge belongs to the installed Cloud application, so applications that
set it must decide which count to use. Email ignores `group` and `badge`.
Neither field is stored on the notification event; both travel only in the
browser delivery payload. The presentation body still stays out of that payload.

Without an active endpoint, Cloud records `no_endpoint` for that browser
delivery. A later configured recommended channel can still receive the event.
There is no in-app notification card or separate notification WebSocket.
Ordinary interface feedback, such as a saved confirmation, is unaffected.

Use the browser client to read and change the current browser's registration:

```ts
import { browserNotificationClient } from "@k2b/cloud/browser/notifications";

const initial = await browserNotificationClient.refreshExisting();

enableNotificationsButton.addEventListener("click", async () => {
  const state = await browserNotificationClient.enable();
  console.log(state.enabled);
});
```

`refreshExisting()` registers the Cloud service worker and reconnects an
existing subscription. It never asks for permission. Call `enable()` only from
an explicit user action because it may open the browser permission prompt.

Use `state()` to inspect support, permission, and subscription state. Use
`disable()` to disable the endpoint and unsubscribe this browser. Before sending
a queued browser delivery, Cloud checks that its endpoint is still active.
Disabling or rebinding that endpoint prevents later attempts from sending to it.

After reading a group's content, close its notifications on the current device
and update the badge from the open tab:

```ts
import { browserNotificationClient } from "@k2b/cloud/browser/notifications";

await browserNotificationClient.closeGroup("inventory", "stock:item-42");
await browserNotificationClient.setBadge(remainingUnreadCount);
// Use setBadge(0) to clear the badge.
```

`closeGroup(appId, group)` closes only notifications with that application's
group tag on the existing Cloud service-worker registration (scope `/`).
It never registers a worker or prompts for permission. Unsupported browsers,
missing registrations, and invalid inputs silently do nothing.
`setBadge(count)` also silently does nothing when unsupported, refused, or
given a count that is not a non-negative safe integer.

Closing a group affects only the reading device. Web Push cannot reliably
close notifications on other devices, and closing notifications does not
change the badge automatically.

Browser delivery requires a secure context, service-worker and Push API support.
On iPhone and iPad, Cloud must run as an installed Home Screen application.

### Email delivery

Core delivers email through the default [outgoing mail profile](/en/docs/operations/outgoing-mail). Configure and test that sender before enabling email notifications.

Email delivery is available when the resolved recipient has an address:

- a direct email recipient supplies it in the send call;
- a user recipient uses the email address stored on the Cloud user.

If a user has no email address, Cloud records `no_endpoint` for that email
delivery.

An `email()` renderer can override the neutral presentation. Without it, Cloud
uses the notification title and body.

### Deployment channels

Channel drivers belong to the deployment. They do not belong to an
application.

A deployment package can add typed channels. Applications can then use those
channels in their delivery policy.

Extend the channel registry, then register the driver during deployment
startup:

```ts
import {
  registerNotificationChannel,
  type NotificationChannelDriver,
} from "@k2b/cloud/services";

declare module "@k2b/cloud/contracts/notifications" {
  interface NotificationChannelRegistry {
    sms: true;
  }
}

const smsDriver: NotificationChannelDriver = {
  id: "sms",
  async resolveDestinations(recipient) {
    const phone = await resolvePhoneNumber(recipient);
    return phone
      ? [{ key: phone, label: "SMS", context: { phone } }]
      : [];
  },
  createPayload({ presentation, destination }) {
    return {
      phone: (destination.context as { phone: string }).phone,
      text: [presentation.title, presentation.body].filter(Boolean).join("\n"),
    };
  },
  async deliver(payload) {
    await smsProvider.send(payload as { phone: string; text: string });
  },
};

const unregisterSms = registerNotificationChannel(smsDriver);
```

A driver resolves destinations, builds a persisted provider payload, and
delivers that payload. `deliver(payload, context)` receives an optional second
argument with `deliveryId` and, during worker processing, an abort `signal`.
For an email recovery, it also includes the persisted `outgoingMailId`.
Existing drivers may keep returning `void` to indicate delivery. A driver that
hands work to a durable provider may return `{ status: "pending", retryAfterMs,
errorMessage? }` with a finite `retryAfterMs` greater than zero. Cloud clamps
that delay to 2,000–300,000 ms, persists the pending state with no error code,
preserves the notification attempt budget, and schedules another call. A `pending` return
without a valid delay is treated as delivered, like `void`. An optional
`outgoingMailId` is recorded only when it is a UUID string. A completed driver
may return `{ status: "delivered" }`.

Channel IDs are lowercase identifiers with at most 80
characters. Register one driver per ID. Keep the returned cleanup function and
call it when the deployment integration stops.

## Send a notification

Send after the domain change commits. Use the bound definition from
`defineApp()`.

Build the idempotency key from the domain change.

```ts
import { notifications } from "@k2b/cloud/services";
import { getLocale } from "@k2b/cloud/server";
import { app } from "./config";

const result = await notifications.send(app.notifications.stockLow, {
  recipient: { userId: ownerId },
  data: {
    itemId,
    itemName,
    remaining,
  },
  idempotencyKey: `stock-low:${itemId}:${thresholdVersion}`,
  locale: getLocale(c),
});
```

### Set the send options

| Option | Required | Meaning |
| --- | --- | --- |
| `recipient` | Yes | `{ userId }` or `{ email }`, fixed by the definition |
| `data` | Yes | Payload parsed with the definition's Zod schema |
| `idempotencyKey` | Yes | Stable identity for this logical event |
| `sentBy` | No | Cloud user ID attributed as the sender |
| `locale` | No | Intended locale for `render` and `email`; canonicalized and defaults to `en` |

Omit `sentBy` for a system-generated notification. When present, it must be the
ID of an existing Cloud user. Arbitrary actor IDs and process names are not
valid.

At a request seam, pass `getLocale(c)`. A background sender must pass the
locale persisted with its work or deliberately use the operator's `app.locale`
setting. Locale is delivery metadata, not part of `data` or the idempotency
identity.

### Deduplicate retries

Cloud trims `idempotencyKey` and accepts from 1 to 300 characters. Event
identity consists of:

- the bound notification definition;
- the resolved recipient;
- the idempotency key.

Sending the same combination returns the existing event. It does not create a
duplicate.

Use an order ID, resource version, or committed transition ID. Do not use the
current timestamp.

Cloud owns provider retries. Calling `send()` again does not restart them.

### Send after commit

The application remains the source of truth for the event. Persist the stock
change, export result, invitation, or other domain state first. Send the
notification after the transaction commits.

If the application recovers from a crash between those operations, it can call
`send()` again with the same idempotency key. Cloud returns the existing event
when the first call already created it.

### Handle send errors

`notifications.send()` rejects when it cannot form a valid event. Validation
failures before event creation include:

- an empty or overlong idempotency key;
- payload data rejected by the Zod schema;
- an error from `render()`;
- an empty or overlong title, overlong body, unsafe `targetHref`, invalid `group`, or invalid `badge`;
- a user ID that does not exist;
- an invalid direct email address.

Storage and catalog failures also reject the call.

An error from the optional `email()` renderer occurs while Cloud prepares the
email delivery. It appears as a failed delivery with `preparation_failed`.

After Cloud creates the event, delivery problems appear in the result. A
missing required channel returns an `error` summary.

### Required channels wait

Required deliveries are attempted before `send()` returns. Recommended
deliveries are queued.

A route that requires a channel therefore includes its initial delivery attempt
in request latency.



## Read the result

`notifications.send()` returns one event summary and an entry for every
persisted channel delivery.

```ts
type TypedNotificationSendResult = {
  id: string;
  created: boolean;
  status: "queued" | "delivered" | "suppressed" | "error";
  deliveries: Array<{
    id: string;
    channel: string;
    required: boolean;
    status:
      | "deferred"
      | "pending"
      | "sending"
      | "delivered"
      | "suppressed"
      | "failed";
    errorCode: string | null;
  }>;
};
```

`created` is `false` when the event already existed.

### Read the event status

| Status | Meaning |
| --- | --- |
| `queued` | At least one persisted delivery is pending or sending |
| `delivered` | At least one persisted delivery completed and no required delivery has an error |
| `suppressed` | No persisted delivery is pending, sending, or delivered |
| `error` | A required delivery was suppressed, failed, or has an error code |

Delivery status describes provider processing. `delivered` confirms provider
acceptance, not that the operating system displayed a notification or that the
recipient read it.

### Read each delivery

| Status | Meaning |
| --- | --- |
| `deferred` | A later recommended fallback is waiting for earlier choices |
| `pending` | The delivery is ready for a worker or a scheduled retry |
| `sending` | A worker owns the current attempt |
| `delivered` | The channel provider accepted the delivery |
| `suppressed` | Cloud intentionally did not attempt this destination |
| `failed` | Delivery ended without another retry |

For recommended channels, Cloud queues the first selected choice. A successful
delivery suppresses later choices as `fallback_not_needed`. A terminal failure
activates the next deferred choice.

Required channels do not use this fallback chain. Cloud attempts every required
delivery.

### Read error codes

The typed send result exposes the current delivery error code. Built-in
platform codes include:

| Code | Meaning |
| --- | --- |
| `disabled_by_user` | The user disabled every recommended channel |
| `no_preferred_channel` | No recommended channel or user preference exists |
| `channel_unavailable` | No driver is registered for the selected channel |
| `no_endpoint` | The recipient has no usable destination for the channel |
| `preparation_failed` | Destination resolution or payload creation failed |
| `fallback_not_needed` | An earlier recommended channel delivered the event |
| `payload_missing` | A persisted delivery has no usable encrypted payload |
| `lease_recovered` | Cloud recovered an interrupted delivery attempt |
| `endpoint_gone` | A browser endpoint no longer exists |
| `provider_rejected` | A browser provider rejected a non-retryable request |
| `provider_error` | A provider failed without a more specific public code |

Custom channel drivers may add codes. Branch on status first. Use error codes
for diagnostics.

User-facing history normalizes unknown provider-specific errors to
`provider_error`.

### Delivery retries

Cloud retries retryable provider failures with backoff for up to five delivery
attempts. Non-retryable failures move directly to `failed`.

Temporary SMTP failures keep email deliveries `pending` while outgoing mail
retries them. Waiting for accepted mail does not use notification attempts and
keeps the delivery error code null, so a required email reports `queued`. The
last SMTP answer may remain in the delivery error message for operators. Other
retryable channel failures keep their error codes, so required deliveries in
retry continue to report `error`.
Recommended fallback channels activate only after a terminal mail failure,
which can take up to the 24-hour delivery deadline. They stay deferred while
SMTP retries continue, so a recovered SMTP server does not cause delivery
through both channels.
The outgoing-mail record settles within its 24-hour deadline. Permanent SMTP
failures and mail cancellation end the notification delivery; mail availability
failures retry, while profile and input policy errors fail immediately.

Delivery observability includes `outgoingMailId` and `outgoingMailStatus`, so
operators can follow the email in the send log, including a later `bounced`
status. The ID remains after mail record retention; its status then becomes null.
**Observability → Notifications** (`/admin/observability/notifications`) shows
the mail status under the email channel, and the Accounts batch detail shows it
under each recipient's status, whenever it adds information, such as `queued`,
`failed`, or `bounced`. The mail ID appears as the line's tooltip.

The delivery runtime also recovers an attempt left in `sending` after a worker
stops. It returns the delivery to `pending` and records `lease_recovered`.

PostgreSQL retains delivery state and retry times. Core checks for due work at
startup and every 30 seconds. An interrupted `sending` attempt becomes eligible
for recovery after five minutes.



Calling `notifications.send()` again with the same idempotency key is safe, but
it does not restart provider delivery. The existing event and current delivery
state are returned. Cloud's delivery worker owns retries and recovery.

## Notification batches

Notification batches enqueue chunks of up to 100 recipients into outgoing mail's
bulk lane as app `core`. The default profile's pace and daily recipient limit for
app `core` apply. Batches continue as the rolling 24-hour window frees capacity.
Core's magic links, password resets, and other notification email share this
limit: leave headroom or keep the default profile unlimited. Recipients remain
`sending` until their mail settles; batch counters and message history then
record `sent` (also for `bounced`) or `error` for failed or cancelled mail.

Worker retries and stale claims reuse the same send generation and mail ID.
An explicit failed-recipient retry creates a new generation. If retention
removed a mail record before reconciliation, recovery records an error instead
of automatically sending it again. Temporary backlog,
quota, or availability failures leave recipients pending for another attempt;
profile and input policy errors mark them as errors.
