---
title: Resource types and discussions
navTitle: Resource discussions
section: Platform services
order: 564
description: Declare resource containment, a standard reader presentation, and a discussions provider without application-specific consumers.
tags: [capabilities, resources, discussions, authorization]
updated: 2026-10-29
---

# Resource types and discussions

Declare resource relationships once on your capability Types. A consumer can
then recognize an item, find its container type, and display its authorized
reader result without knowing your application's domain fields.

```ts
types: {
  collection: {
    title: "Collection",
    description: "An inventory collection.",
    reader: "collection.read",
    access: { readable: readableCollectionPrincipals },
  },
  item: {
    title: "Item",
    description: "An inventory item.",
    reader: "item.read",
    container: "collection",
    access: { readable: readableItemPrincipals },
  },
},
discussions: {
  item: "item",
  containers: "collection.list",
  activity: "collection.activity", // Optional.
},
```

## Describe containment

`types.X.container` is an optional local Type ID in the same application.
Startup rejects an unknown type, self-reference, or cycle. Each Type has at
most one container Type. Chains such as record → table → base are supported.
This describes the type hierarchy, not an arbitrary object tree: a single
Type used for both files and folders cannot contain itself.

Containment grants no rights, selects no operation target, and adds no event
place rule. The provider still checks each resource's current container and
permissions. Existing reader data and app-owned relationships stay available.

## Return a standard reader view

Import `CloudResourceReaderViewSchema` from `@k2b/cloud/contracts` and add a
required `view` property to your reader's data schema:

```ts
const ItemDataSchema = ExistingItemDataSchema.extend({
  view: CloudResourceReaderViewSchema.required({ container: true }),
});
```

The view contains:

```ts
{
  title: string;                     // 1–500 characters.
  context?: string;                  // 1–200 characters, in the caller's locale.
  status?: string;                   // 1–60 characters, in the caller's locale.
  done?: boolean;
  permission: "read" | "write" | "admin"; // Effective permission of this caller.
  container?: { ref: { type: string; id: string }; title: string };
}
```

Use the presentation meaning of `CloudResourceReferenceSchema`: a current
label, concise context, and short status. The `container` view is required
when the Type declares a container. Return that resource's current container
ref and title. Never disclose a title or permission before authorizing the
reader. Consumers that cache localized views must include locale in their
cache key.

An `open` semantic link in the reader envelope is recommended so consumers can
offer “Open in …”. It is optional: a reader with a compatible view can offer
discussions without an open link. Chat hides its open-resource controls when
the link is absent.

The compiler derives view support from the reader's data schema. There is no
second author declaration to keep synchronized. An optional or incompatible
`view` stays ordinary domain data and does not advertise standard view
support. This preserves existing reader contracts. Both the item and its
container Type need a guaranteed compatible view to offer discussions; an
incompatible discussions declaration fails startup.

`CloudResourceViewSchema` remains the existing search-result contract, with
identity and links. The reader view above has its own name and purpose.

## Offer discussions

One application may declare one `discussions` role. `item` names a local Type
with a container; `containers` names a normal, closed-world Query listing
containers the current caller can read. Reuse these contracts from
`@k2b/cloud/contracts`:

- `DiscussionContainersInputSchema`: `{ query?, cursor?, limit? }`; limit is
  1–100 and defaults to 50.
- `DiscussionContainersDataSchema`: `{ items, next }`. Each item has
  `{ ref, title }`; `next` is an opaque cursor or `null` on the last page.
  Changing `limit` between pages continues after the last returned item.
- Optional `DiscussionActivityInputSchema`: `{ container, item?, timeZone?,
  before?, after?, cursor?, limit? }`. `container` and `item` are opaque
  resource IDs of the role's declared Types. Limit is 1–100, default 50;
  timestamp bounds have explicit offsets. `timeZone` is the caller's IANA
  display zone.
- `DiscussionActivityDataSchema`: at most 100 `ResourceActivityEventSchema`
  events as data, with continuation in the normal capability `page` envelope.
  Events carry ID, timestamp, nullable item ref, optional title, actor,
  icon, sentence, optional open URL, and count. The provider authorizes both
  the container and any requested item and returns only readable activity.
  Providers may add fields to events, actors, and refs. Consumers strip fields
  they do not understand; the documented required fields remain required.

These operations cannot stream or use app authority. `discussionsIssues(manifest)`
checks the role, views, and operation schemas. Startup rejects incompatible
providers; the registry and consumers ignore an incompatible role while
retaining the application's other capabilities.

`discussionProviders(caller, { deadline, signal?, page? })` from
`@k2b/cloud/capabilities/server` discovers compatible providers through the
current caller's paginated catalog. It returns `{ app, itemType,
containerType, containers, activity? }` descriptors. Discovery has a shared
60-call, 4 MiB budget and one catalog request in flight. `deadline` is an
absolute epoch millisecond time. Cancellation, repeated cursors, unavailable
pages, or an exhausted budget throw; a partial list is never reported as
complete. No identity or provider data survives the call. Subsequent list,
reader, and activity calls use the ordinary capability client and the
caller's authority; callers must budget those calls as well.

Consumers can supply `page(read)` to include every catalog page in their own
request budget. The callback must execute and return `read()` or reject when
the budget is exhausted. Discovery retains its own call, byte and deadline
limits. Chat uses this callback to share one budget with lists and readers.

A discussions role works without reader checks. Push consumers require
`access.readable` on both the item and container Types; otherwise they must
report that push is not configured. The role itself grants no access.

## Check current principal readability

Each Type may independently provide
`access: { readable?: (input, context) => principals }`. The callback may be
async. Input is `{ id, container?, principals }`, with at most 500 concrete
accounts. `ResourcePrincipalSchema` reuses the existing grant principal shapes:
`{ type: "user", userId }` or `{ type: "service_account", serviceAccountId }`.
Groups and wildcard grants are resolved by the provider, never supplied as
candidate accounts.

The platform generates `<typeLocalId>.readable`, with fixed
`ResourceReadableInputSchema` and `ResourceReadableDataSchema`:
`{ id, container?, principals } → { readable }`. For a contained Type, the
generated input requires `container`, fixes its Type to the declared local
container Type, and leaves its ID opaque. Do not declare this Query yourself;
a name collision fails startup. Before calling application code, the platform
filters candidates through the shared current-account resolver: users must exist, be unexpired,
and belong to an enabled account category; service accounts must exist and
have active status. A `user_delegated` service account's user must also pass
these user checks. Disabled, expired, and deleted accounts never reach the
callback. This checks accounts rather than credentials and does not apply
credential scopes. The framework rejects callback results containing any
principal outside that filtered input.

Implement the callback with current principal rights:

- Resolve direct, group, authenticated, and public grants as supported by
  your resource service, including resource bindings.
- Disabled, expired, or deleted accounts are not readable. An unknown or
  deleted resource, or an item moved out of the expected container, returns
  an empty subset.
- Check the account's rights without applying a particular credential's
  scopes. A service account may own rights that one of its credentials
  cannot exercise; this check concerns the account.
- Return only input principals that can currently read. Return no content,
  title, or permission details. The result never grants content access.

Providers can use `resolveResourceReaders(principals)` from
`@k2b/cloud/services/identity`. It returns current accounts as
`ResourceReader` values with the original `principal`, effective `subject`,
and nullable resource `binding` (`appId`, `resourceType`, `resourceId`).
Delegated service accounts resolve to their current user's subject. Expired
users, disabled account categories, disabled service accounts, and missing
accounts are omitted. UUID matching ignores letter case while the returned
principal preserves the input spelling. Only category `enabled` settings affect
this check; presentation settings such as `visible` and `login.label` do not.
Use the subjects with `getEffectivePermissions()` from
`@k2b/cloud/server`, then enforce each non-null binding against the resource.
The helper creates no session and supplies no credential scope ceiling.

The callback receives `CapabilityAppExecutionContext`: app actor,
`accessSubject: { type: "none" }`, `user: null`, locale, request ID, origin,
and cancellation signal. It has no nested `query`, person authority, or
interactive credential. Admission is covered by
[App-to-app reader checks](/en/docs/platform/app-to-app-queries).

## Inspect and test the projection

The manifest keeps these additive facts at its top level:

```ts
resourceTypes?: Array<{
  type: string;             // Local Type ID.
  container?: string;       // Local container Type ID.
  view?: true;              // Derived from compatible reader data.
  readable?: true;          // Availability of the generated reader check.
}>;
discussions?: { item: string; containers: string; activity?: string };
```

Manifest readers drop projections with missing Types, remove view support if
its reader is unavailable, and remove readable support unless the exact
`<typeLocalId>.readable` app-only Query remains available. They omit roles
whose named Queries are unavailable.
The `readable` boolean is an availability claim, not a reference to a person
Query: Core validates the full manifest first, then retains this fact when
person catalogs hide the generated Query. `CapabilityCatalogSchema` reads
that person projection; `CapabilityManifestSchema` reads a full manifest.
The Query entry itself carries `appOnly: true`, so older readers drop that
entry. Older Core keeps the Type and its ordinary reader while ignoring the
new top-level facts. Upgrade Core before deploying providers using this role.

Provider tests can run `typeViewIssues(manifest, localTypeId)` and
`discussionsIssues(manifest)`. Use `assertResourceView(result,
expectedContainerRef?)` beside `assertResourceOpenLink(result)` from
`@k2b/cloud/capabilities/testing`. The former validates `result.data.view`
and, when supplied, the exact expected container ref. Cover every permission
level and locale your reader supports, account status, group rights, service
accounts without credential scope ceilings, and moved items with a stale
expected container.

## Built-in providers

Spaces declares `item` inside `space`; Notebooks declares `note` inside
`notebook`. Both Types in each pair expose `access.readable` and a standard
reader view. Spaces task views include the current column or localized Done
status, completion flag, and a due date when relevant. Event views include the
localized schedule and completion flag. Notebook and note views describe
their resource without a task status or completion flag.

The roles use `space.containers` and `notebook.containers` for the standard
`{ items, next }` container list. The published `space.list` and `notebook.list`
array results remain available. Activity uses `space.activity` and
`notebook.activity`: send `container`, or retain the published `space` or
`notebook` field. At least one is required; if both are present, their IDs must
match. Both accept `timeZone`; notebook activity has no date presentation
that changes with that option.

Readers preserve their existing domain fields, including the item's
`container: { ref, name, permission }`, beside `view`. Ordinary readers and
activity still enforce the caller's credential limits. The generated
`readable` checks concern account rights, so a service account with a
credential lacking read scope can still be reported as readable. Resource
bindings, current account status, and current grants remain mandatory.
