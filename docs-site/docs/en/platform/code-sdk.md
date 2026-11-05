---
title: Code SDK
navTitle: Code SDK
section: Platform services
order: 680
description: Generate a typed Code SDK from application capability contracts and call operations through resource handles.
tags: [code, capabilities, sdk, handles]
updated: 2026-11-05
---

# Code SDK

Code imports its installation's generated SDK as `@sdk`. Handles select the
resource an operation acts on. The available factories, methods, inputs and
results come from [application capability manifests](/en/docs/platform/capabilities).
Third-party applications use the same path as built-in applications.

`secrets.NAME` supplies a secret marker and `http.fetch` dispatches a bounded public HTTPS request.
The checker collects exact origins into `manifest.internet`; declare dynamic destinations
and redirect origins with a literal `http.allow(["https://api.example.com"])` list.
Read [Code secrets](/en/docs/platform/code-secrets) for approved destinations and result encoding.

This is the Phase 1 SDK contract on the Code integration branch. The SDK
registers schedules; Core owns scheduling, authorization and execution.

## Call operations on a handle

For a provider that declares a `workshop` Type and an `item.create` Action
with `target: "workshop"` and `idempotency: "required"`:

```ts
import { app, owner, work_shop } from "@sdk";

const destination = work_shop.workshop("workshop-finance");

app.schedule("0 8 * * 1", async () => {
  await destination.item.create({
    title: "Weekly review",
    idempotencyKey: "weekly-review:2026-11-02",
  });
}, { name: "weekly-review" });

export default app;
```

`work_shop` is the export for an application ID of `work-shop`. Hyphens become
underscores; reserved export names receive an underscore prefix, such as
`default` → `_default`. The generation manifest records the mapping.

A handle offers only operations whose `target` is its Type. An operation
without a target belongs to `work_shop.app()`. Method paths preserve the
operation's local ID: `item.create` becomes `.item.create(...)`. A callable
method can also have child methods, such as `.keep(...)` and `.keep.release(...)`.
A Type named `app` uses `.app(id)`, alongside the app-wide `.app()` factory.
`owner` is the fixed resource or application handle supplied when generating
resource-owned Code. A handle grants no access: the dispatcher and the owning
application check permissions on every call.

All Code modes accept string IDs, including values from Query results and
dynamic templates. Literal IDs remain visible in checker review evidence;
dynamic ones retain only their Type there. The target checks the account's
current rights at execution. A handle or setting that names a target grants
no access.

## Supply additional targets and retry keys

If an Action declares `refs: { destination: "workshop" }`, pass another
workshop handle as `destination`. A plain ID or `{ type, id }` object does not
satisfy the handle type.

```ts
await owner.item.move({
  itemId: "item-in-owner",
  destination: work_shop.workshop("workshop-finance"),
});
```

The SDK removes ref fields from domain input and writes their coordinates into
`call.refs`. It similarly lifts an Action's `idempotencyKey` into
`metadata.idempotencyKey`. The key is required when the Action declares
`idempotency: "required"`. Actions with `idempotency: "none"` reject a key,
matching the dispatcher contract. Choose a stable key from
the business operation, such as a message ID and revision. Keys are trimmed,
contain 1–200 visible ASCII characters, and cannot contain spaces. Repeating a key
has the platform's existing 24-hour idempotency semantics.

Methods resolve the operation's domain `data`, typed from `dataSchema`.
Bridge refusals reject the promise; catch a failure only when the Code can
recover. Streaming operations, Actions marked `code: false`, and app-only
Queries are absent from the SDK.

## Choose the execution mode

| Mode | Handle IDs | `app` | `owner` |
| --- | --- | --- | --- |
| `resource` | Literal types | Available | Required fixed resource or app |
| `personal` | Dynamic strings allowed | Available | Absent |
| `code_run` | Dynamic strings allowed | Absent | Absent |

`code_run` uses the same operation signatures for one chat execution. It has
no schedule registrations, version or owner. The chat execution path still
asks for writing Actions as required by the normal approval policy.

## Name an automation

Give a schedule a stable name for manual execution and an optional readable
title in its third argument:

```ts
app.schedule("0 8 * * 1", weeklyReview, {
  name: "weekly-review",
  title: "Weekly review",
});
```

`title` is optional. It is trimmed, must contain 1–200 characters, and must be
one line of plain text without HTML markup or control/format characters.
Cloud displays it as escaped text. Declare a constant title; imported options
need literal types, for example `as const`. The title appears wherever people
see the automation; without one, Cloud shows its identifier. Changing a title
creates a new checked version with the usual review and activation rules.
Titles need not be unique; the stable name identifies the automation.

Names contain letters,
digits, dots, underscores or hyphens, start with a letter or digit, and must be
unique in the module. Keep the name across versions to identify the same task.

## Recognize later-phase APIs

The `app` type includes `schedule`, `on`, `get`, `post`, `put`, `delete`, `all`,
`nav`, `webhook`, and `fetch`. Only `schedule` is available in Phase 1.
Route, navigation and fetch registrations report
`app.<method> kommt in Phase 2`; events and webhooks report Phase 3. The runtime
also refuses these calls. Declaring a later-phase method never silently
registers a working route or event handler.

Eligible event payloads come from event schemas. Events with
`automation: false` are absent. Future route contexts provide `c.req`,
`c.user`, `c.json`, `c.text`, `c.html`, and `c.redirect`. Webhook contexts have
`c.verify(secret)` and no `c.user`. Navigation controls presentation only;
a route must check its own authorization.

## Generate and host an SDK

Platform tools import `generateCodeSdk` from `@k2b/cloud/code`:

```ts
import { generateCodeSdk } from "@k2b/cloud/code";

const sdk = generateCodeSdk(manifests, {
  mode: "resource",
  owner: { kind: "resource", ref: { type: "work-shop.workshop", id: "workshop-owner" } },
});
```

Supply the current validated `CapabilityManifest[]`. Write `sdk.declarations`
as `sdk.d.ts`, `sdk.runtime` as `sdk.js`, and resolve `@sdk` to that pair in
the checker and bundler. Both generated files are standalone. JSON Schema
shapes become structural TypeScript; constraints such as string lengths
remain validated by the dispatcher. Local schema references are supported;
unresolved or external references fail generation.

`GeneratedCodeSdk` contains a version-1 `CodeSdkManifest` with:

- `apps`: module export names and originating manifest hashes;
- `handles`: target Types, factory property paths and app export names;
- `operations`: qualified IDs, method paths, targets, refs, input/data schemas,
  schema hashes and idempotency policy;
- `events`, `omitted`, and `appMethods`: eligible events, excluded operations
  and the phase required by each app method;
- `mode` and optional `owner`: the execution mode and fixed owner.

The checker uses these paths with the user's source to resolve handle literals and
permissions. This generation manifest is not a checked version manifest or
an authorization grant. `codeSdkPhaseDiagnostic(method)` returns the shared
Phase 1 diagnostic so the checker can attach a source location.

The runtime exports an internal `__codeSdk` control object for the trusted
host. Import the SDK and bind it once **before evaluating the user module**
with `__codeSdk.bind(cloud)`, where `cloud` satisfies
`CodeSdkBridge`. Each method calls `cloud.call(capability, invocation)`.
`CodeSdkInvocation` separates the canonical `NormalizedCapabilityCall` in
`call` from transport metadata in `metadata`; hash only `call` with
`capabilityCallDigest`. The bridge resolves domain data and throws on refusal,
matching the runner's `cloud.call(operation, input)` seam. It attaches run
identity and credentials outside the sandbox. The checker must reserve
`__codeSdk` for the host and reject imports of it from user code; hiding it
from declarations alone does not enforce that rule.

`__codeSdk.entries()` returns schedule descriptors with `kind`, `cron` and
an `entrypoint` equal to the explicit schedule name, plus `title` when declared. For unnamed schedules,
entrypoints use registration order (`schedule:0`, `schedule:1`, …); these are
version-local and change when registrations are reordered.
Registration does not execute callbacks. The checker must import Code once
to collect its registrations. Core uses those descriptors to schedule work;
the trusted bundle wrapper invokes
`__codeSdk.run(entrypoint)` for the selected callback. The one-shot host binds
the bridge and executes its Code directly instead.

`CodeSdkOptions`, `CodeSdkOwner`, `CodeSdkOperation`, `CodeSdkHandle`,
`CodeSdkInvocation`, `CodeSdkCallMetadata`, `CodeSdkBridge`, and
`CodeSdkPhaseDiagnostic` are exported with doc comments for checker, test-kit,
CLI and chat consumers. The SDK imports no database, broker, storage or
credential clients.

The [Code checker](/en/docs/platform/code-checker) consumes this generation
manifest to produce the immutable `CodeVersionManifest`, source locations,
permission changes, and the runner's ESM bundle.

## One-off chat runs

Gustav's one-off `code_run` compiler supplies the same `generateCodeSdk` output
with `mode: "code_run"`. It binds normalized targets, refs and idempotency
metadata to the existing capability host, preserving its access checks and
approvals. SDK methods return domain data; the older `cloud.capabilities.run`
keeps returning its capability envelope. This mode has no `app` or `owner`,
and accepts dynamic IDs. The host also exports its existing `cloud.sheet`
helpers as `sheet` from `@sdk`. Other package imports remain unavailable.

See [Gustav Code tools](/en/docs/platform/gustav-code-tools) for a one-call CSV
example and the lasting-Code workflow.

The existing `cloud.capabilities.run(name, input, options?)` also accepts explicit
normalized `target`, `refs` and `idempotencyKey` in its optional third argument.
A key is allowed only for an Action declaring required idempotency; retain it
for retries of the same effect. Omitting it preserves the existing per-call
key. Scripts and Studio apps keep the same permissions and approvals.


## Mail triage: category first

Discover `core.ai.decide` in the live SDK before using it. It is a read-only query
and returns typed answers with probabilities, plus model and usage. The checker
marks this call as **AI** (**KI**); the Cloud-Admin policy controls release.
The caller's person or service account pays from its own AI allowance.

Ask category first. Ask urgency together with category or after it, never alone.
This one-off `code_run` example returns a review flag only for confidently
classified support messages. Urgent spam stays outside that category. Thresholds depend on the cost
of mistakes; probabilities are estimates. The example changes no records.

<!-- ai1-mail-triage -->
```ts
import { core } from "@sdk";

export default async function triage() {
  // Fictional mail; in real Code, read the mail through its authorized SDK first.
  const result = await core.app().ai.decide({
    task: "mail.triage",
    state: { subject: "Urgent: claim your prize", text: "Act now to receive a prize." },
    questions: {
      category: {
        type: "choice",
        instructions: "What kind of message is this?",
        criteria: { support: "Help with an existing order", spam: "Unsolicited advertising or deceptive messages" },
      },
      urgent: { type: "noul", instructions: "Does this message need urgent attention within its category?" },
    },
  });
  const category = result.answers.category;
  if (category?.type !== "choice" || category.choice !== "support" || category.confidence < 0.9) return false;
  const urgent = result.answers.urgent;
  return urgent?.type === "noul" && urgent.probability >= 0.9;
}
```

For lasting Code, save this function in a helper module and call it from a
schedule. Schedule callbacks return `void`; use the flag inside the callback
when deciding whether a separate authorized action is appropriate.

Optional images and `model: { id }`, provider-dependent image support, quota
failures and byte limits follow
[Typed decision questions](/en/docs/ai/structured-and-background-ai#ask-typed-decision-questions).
