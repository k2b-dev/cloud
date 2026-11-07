---
title: Code SDK
navTitle: Code SDK
section: Platform services
order: 680
description: Build checked TSX pages, serve routes and call application operations through a generated typed Code SDK.
tags: [code, capabilities, sdk, handles]
updated: 2026-11-06
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

The SDK registers routes and schedules. Core owns hosting, scheduling,
authorization and execution.

## Return a page

Start with a TSX page:

```sh
cld code init --title 'Workshop' --owner-type work-shop.workshop --owner-id workshop-owner
cld code sdk pull ./code/work-shop/workshop-owner
cld code check ./code/work-shop/workshop-owner
```
 Resource- and app-owned projects start with
`code.tsx`; personal projects start with a schedule because they cannot host routes.

Use `c.page(tree)` for a Cloud-rendered document. In a `.tsx` entry file, import
`jsx` and the description components from `@sdk`. The checker compiles TSX with
this factory. The generated `tsconfig.json` includes `.ts` and `.tsx` files and
sets `jsx: "react"` with `jsxFactory: "jsx"`. No React, Hono or Solid runtime is
needed; the factory produces description objects.

```tsx
import { app, jsx, Page, Section, Text, Form, Chart } from "@sdk";

app.get("/", c => c.page(
  <Page title="Workshop">
    <Section title="Today">
      <Text>Scan an item to open its details.</Text>
      <Chart.Bar title="Items" data={[{ label: "Ready", value: 12 }]} />
      <Form title="Find an item" action="/find" submit="Find"
        fields={[{ type: "scan", name: "barcode", label: "Barcode", required: true }]} />
    </Section>
  </Page>
));
app.post("/find", async c => {
  const form = await c.req.formData();
  return c.redirect(`/items/${encodeURIComponent(String(form.get("barcode") ?? ""))}`);
});
```

Components build data only. The root is `{ version: 1, kind: "Page", title,
children }`. Plain objects are an equal alternative, for example:

```ts
app.get("/", c => c.page({
  version: 1, kind: "Page", title: "Workshop",
  children: [{ kind: "Text", text: "Your Code page is ready." }],
}));
```

TSX and objects produce the same tree and pass the same Core validation. Core checks
every returned tree before rendering it. Text is escaped. Unknown kinds and
properties, HTML/SVG, event handlers, functions, accessors and foreign links
are rejected. `c.html()` is unavailable.

The version 1 allow-list is:

| Node | Description fields |
| --- | --- |
| `Page` | `title`, `children`; root only, `version: 1` |
| `Section` | `title`, `children` |
| `Text` | `text`; TSX also accepts a text child |
| `Heading` | `text`, optional `level: 2 \| 3 \| 4` |
| `Table` | `title`, `columns: [{ key, label }]`, `rows` of scalar values |
| `Form` | `title`, `action`, `fields`, `submit`; always POST |
| `Detail` | `title`, `items: [{ label, value }]` |
| `Chart` | `description: { kind, … }`; portable chart data, no callbacks |
| `Link` | `label`, `href` |
| `Button`, `Action` | `label`, `action`, optional string `values`; always POST |
| `Notice` | `title`, optional `text`, `tone: info \| success \| warning \| danger` |

Fields have `name`, `label`, `type`, optional `value` and `required`. Types are
`text`, `email`, `number`, `textarea`, `select`, `checkbox` and `scan`. Only
`select` takes `options: [{ value, label }]`. Values match the field type.
Field names are unique; `_csrf` is reserved. Cloud inserts the CSRF token into
forms and actions and removes it before invoking the handler. Links and POST
destinations resolve inside `/code/<id>/`; they cannot leave that Code.

The first renderer presents chart descriptions as their data tables and scan
fields as text inputs. Chart drawings, camera scanning and live subscriptions
are separate renderer work. Supported chart descriptions are `bar`, `line`,
`scatter`, `pie`, `donut`, `histogram`, `gauge`, `sparkline`, `boxplot`, `heatmap`,
`barGauge` and `stat`, with matching `Chart.Bar`, `Chart.Line`, etc. builders.
The portable chart data contract is exported by `@k2b/editor/chart-schema`.

A tree is limited to 64 KiB, 256 nodes and 12 node levels. A table has at most
200 rows and 20 columns; a form has at most 40 fields. Portable chart budgets
are eight series, 200 values per series and 1,600 marks. Request and response
limits still apply to the complete envelope.

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

## Run once at a chosen time

Pass an absolute date-time and an IANA time zone instead of a cron string:

```ts
app.schedule(
  { at: "2026-12-01T09:15:30+01:00", timeZone: "Europe/Berlin" },
  sendSummary,
  { name: "summary-once", title: "Send summary" },
);
```

Both fields must be constants. `at` includes seconds and `Z` or a numeric UTC offset and
selects the exact instant; `timeZone` controls its displayed local time. Cloud
never infers the machine's local zone. The handler registers when the module
loads and runs only when Core admits the due entrypoint. A changed date needs
a new checked version and activation. Keep the name to retain the automation's
identity. Manual starts remain available independently of its scheduled run.

Core admits a due one-time schedule on its next recovery pass, normally within
five seconds. It can recover it after downtime for seven days. Older dates do
not run automatically. The run has the same retry and approval rules as a cron tick. If its previous
run is queued or running, the one-time date stays pending until that run ends
or the recovery window expires. A consumed date does not run again after a restart or version
activation. The automation list shows its `at`, `timeZone`, and a null
`nextRunAt` once consumed or expired.

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

## Serve routes

Routes currently require resource- or app-owned Code with its own Code account.
Personal Code cannot register routes. Register routes at module scope with literal paths. Core hosts the active,
approved version at `/code/<code-id>/…`:

```ts
import { app } from "@sdk";

app.get("/hello/:name", c => c.json({
  hello: c.req.param("name"),
  visitor: c.user?.id,
}));
app.get("/health", c => c.text("Ready"), { public: true });
app.post("/save", async c => {
  const input = await c.req.json();
  // Validate input and perform any authorized SDK calls here.
  return c.redirect("/hello/saved");
});
```

`get`, `post`, `put`, `delete` and `all` accept a handler and optional
`{ public: true | false }`. Paths contain literal segments and named parameters
such as `:id`; declarations match in order. `HEAD` uses the GET handler.
Handlers return `c.json(value, status?)`, `c.text(text, status?)` or
`c.redirect(path, status?)`. Redirects stay inside this Code's namespace;
`/next` resolves to `/code/<code-id>/next`. Code cannot return arbitrary headers,
cookies or HTML. `c.req` provides `raw`, `param(name)`, `query(name)`, `json()`,
`text()` and `formData()`. Core forwards only the request data, never browser
cookies or credentials.

Routes require a signed-in session by default. `c.user` contains that person's
ID and effective group IDs; check it in the handler when access depends on the
visitor. Public routes also require the `public_routes` policy classification and version-bound
administrator approval by default. Existing policy tables initially forbid this new
classification until an operator chooses its rule. Public routes require the literal `{ public: true }` in the checked
version and always receive `c.user === null`, including for signed-in visitors.
There is no platform audience or implicit access to underlying resources.
SDK calls retain the Code's execution principal and its existing grants;
the visitor's grants never become data authority.

POST, PUT and DELETE need a session-bound CSRF token. Read `X-Code-CSRF` from
a preceding GET response and send it as the same header, retaining the cookie.
URL-encoded forms may submit it as `_csrf`; Core removes that field before
dispatch. Public forms use a separate HttpOnly cookie when no session exists.
A token from another session or another Code is refused.

Requests share runner slots and Code concurrency limits. Their eight-second
budget includes queueing; busy admission returns 503 and a deadline returns
504. Mutations are never automatically retried. JSON, plain text and
URL-encoded bodies are supported, up to 8 KiB (4 KiB for public routes).
Responses are at most 128 KiB. Public requests share a 20-per-minute limit per
client network and per Code. The Code page lists route entrypoints and their
last results; request runs appear in Runs with their timing and capability
calls. Visitor input and response payloads are transient.

## Recognize later-phase APIs

`nav` and `fetch` registrations still report Phase 2; `on` and `webhook`
report Phase 3. The runtime refuses these registrations too. Eligible event
payloads come from event schemas; events with `automation: false` are absent.

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
unavailable-phase diagnostic so the checker can attach a source location.

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

`__codeSdk.entries()` returns schedule and route descriptors. Schedules carry `kind`, `cron`, optional `at` and `timeZone`, and
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


## Generate text and extract fields

Discover `core.ai.generate` in the live SDK. It is a read-only query classified
as **AI / KI**, using the caller's allowance and Code's execution budgets.
Use it for summaries, draft text or validated extraction. Put source data in
`input` and trusted instructions in `prompt`.

<!-- gate-1a-generation -->
```ts
import { core } from "@sdk";

export default async function summarize() {
  // Fictional source; read real mail through its authorized SDK first.
  const input = { body: "Please deliver three chairs by Friday." };
  const summary = await core.app().ai.generate({
    task: "mail.summary",
    prompt: "Summarize the message in one sentence.",
    input,
    model: { class: "fast" },
    output: { type: "text", maxChars: 500 },
  });
  const extracted = await core.app().ai.generate({
    task: "mail.extract",
    prompt: "Extract the requested item and quantity from the message.",
    input,
    output: {
      type: "json",
      schema: {
        type: "object",
        properties: {
          item: { type: "string", maxLength: 100 },
          quantity: { type: "integer" },
        },
        required: ["item", "quantity"],
        additionalProperties: false,
      },
    },
  });
  return { summary: summary.output, extracted: extracted.output };
}
```

The generated SDK types describe the request and JSON result. A schema supplied
at runtime cannot become a compile-time TypeScript shape; narrow `output`
before reading its fields. Cloud validates the declared schema before returning
it. For lasting Code, call this helper from a schedule; its callback returns
`void`. Summarizing or drafting does not send or save anything. A separate
application capability performs that effect under its own permissions.

See [Text and JSON capabilities](/en/docs/ai/structured-and-background-ai#generate-text-and-extract-json-through-capabilities)
for schemas, size limits, model selection and stable errors.
