---
title: Notifications
navTitle: Notifications
section: Platform services
order: 530
description: Define, send, and inspect typed notifications.
tags: [notifications, email, browser]
updated: 2026-08-29
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
import { notification } from "@valentinkolb/cloud";
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

`targetHref` must point to a route on the same Cloud origin. External URLs are
rejected.

Keep sensitive details on the destination page. That page must check access.

When `email()` is present, it returns:

| Field | Required | Meaning |
| --- | --- | --- |
| `subject` | Yes | Email subject |
| `content` | No | Plain-text content |
| `rawHtml` | No | HTML content |

Without `email()`, Cloud uses the neutral `title` as the subject and `body` as
the plain-text content.

### Register the definition

```ts
import { defineApp } from "@valentinkolb/cloud";
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

The browser channel needs a user with an active browser endpoint. Each endpoint
gets its own Web Push delivery.

Cloud also sends a live event to active sessions. This is separate from Web
Push.

A Web Push delivery can be `suppressed` while an active session still receives
the live event.

Use the browser client to read and change the current browser's registration:

```ts
import { browserNotificationClient } from "@valentinkolb/cloud/browser/notifications";

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
`disable()` to remove the endpoint and unsubscribe this browser.

Browser delivery requires a secure context, service-worker and Push API support.
On iPhone and iPad, Cloud must run as an installed Home Screen application.

### Email delivery

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
} from "@valentinkolb/cloud/services";

declare module "@valentinkolb/cloud/contracts/notifications" {
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
delivers that payload. Channel IDs are lowercase identifiers with at most 80
characters. Register one driver per ID. Keep the returned cleanup function and
call it when the deployment integration stops.

## Send a notification

Send after the domain change commits. Use the bound definition from
`defineApp()`.

Build the idempotency key from the domain change.

```ts
import { notifications } from "@valentinkolb/cloud/services";
import { getLocale } from "@valentinkolb/cloud/server";
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
- an empty or overlong title, overlong body, or unsafe `targetHref`;
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

### Use the typed API

The email-only `notifications.send({ type: "email", ... })` overload and
`notifications.sendToUser()` are deprecated. They bypass the typed definition
catalog and preference-aware delivery.

New application code calls `notifications.send()` with a bound definition.

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

`suppressed` describes persisted channel delivery. It does not prove that the
recipient saw nothing. An active application session may receive a live browser
event even when no registered Web Push endpoint exists.

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

The delivery runtime also recovers an attempt left in `sending` after a worker
stops. It returns the delivery to `pending` and records `lease_recovered`.

PostgreSQL retains delivery state and retry times. Core checks for due work at
startup and every 30 seconds. An interrupted `sending` attempt becomes eligible
for recovery after five minutes.

When upgrading from the queue-based delivery runtime to the job-based runtime,
stop the old application instances before starting the new version. Preserve
the notification tables: startup recovery resumes accepted pending deliveries,
including work whose old queue message has not run. Future retries resume when
their stored retry time arrives. The old queue is no longer consumed; removing
its transport resources is separate operator cleanup, after delivery recovery
has been verified.

Calling `notifications.send()` again with the same idempotency key is safe, but
it does not restart provider delivery. The existing event and current delivery
state are returned. Cloud's delivery worker owns retries and recovery.
