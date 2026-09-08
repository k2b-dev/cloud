# Build a business application in Grids

Use this guide when the request is an application or operational process, not just a record edit. Read [Grids CLI](grids.md) for commands and fetch the installed machine references before writing payloads. Build on the user's selected instance; a template is a starting point, not evidence that their business rules are implemented.

## Decide what the application must guarantee

Before creating resources, identify the actors, main journeys, business identities and state transitions. Ask only questions that change the model or risk: individually tracked assets or interchangeable quantities; approval before commitment or after; partial returns or payments; internal staff or isolated customers; currency and invoice scope; integrations that actually execute payments or shipments.

Write a short acceptance checklist. For each transition, state who may invoke it, which current facts must hold, which records change together, which external effects follow, and how a retry is recognized. Do not implement a state machine merely as a freely editable Status column.

## Choose a model that fits the scenario

| Request | Smallest useful model | Critical acceptance test | Boundary to explain |
| --- | --- | --- | --- |
| Simple asset register | Items, Locations and optionally Categories; one unique generated asset code per physical item | A scan resolves the same item after its label changes; duplicate external codes are rejected | No loan ledger or workflow needed just to list equipment |
| Equipment loans | Items, Loans, Loan positions; each position links one item and loan and records issue/return state and timestamps | Two concurrent issues of one item produce one handover; a returned position cannot return a later loan; damaged items are not made available | Kits describe requested bundles, not reservations. Future date-range booking is a separate rule. Do not mix serialised assets with quantities |
| CRM | Organisations, Contacts, Opportunities, Activities; owner is a Principal and customer is a relation | Sales users see only the intended opportunities, including through copied detail URLs; stage actions retain history | Base Read sees the whole Base. Use separately shared Apps and server-side audience queries for narrower access, not personal Views as security |
| Invoicing | Customers, Invoices, Invoice lines; stored quantity/unit price/tax facts, computed totals, document template, delivery state | Issue once under one operation key; source edits cannot change an issued Document; a second delivery request cannot race the first | An HTML Invoice starter is not an E-Invoice. Inspect installed renderers and their supported currency, tax and correction cases. Grids supplies no automatic tax, accounting or legal guarantee |
| Expense reimbursement | Claims, Claim lines, receipt Files, claimant Principal, approval state and payment reference | A claimant cannot approve their own claim; later edits invalidate the exact reviewed version; retries cannot submit a second payment | Four-eyes Finalization supplies version-bound review when its model fits. Payment execution belongs to an explicitly integrated payment system, not a Paid checkbox |
| Merchandise management | Products, Locations, stock movements, order headers/lines, receipt and shipment positions; optional serial/lot records when required | Concurrent picks cannot over-allocate; partial receipts, shipments and returns retain their order-line links; reversing a movement does not rewrite history | First define the bounded scope. Grids is not a prebuilt ERP: accounting, valuation, taxes, procurement optimisation, carrier and payment integrations require explicit owners and verified operations |

Separate Cloud identity from business identity: public Grids IDs are resource references, generated/unique fields are asset or invoice codes, Principal values reference Cloud users/groups, and labels are display text. An organisation/contact record does not grant Cloud access. For repeated external imports, use external upsert bindings and current versions rather than search-then-create.

For stock quantities, an append-only movement table can preserve receipts, issues and corrections. A computed balance is a read, not a reservation lock. Do not claim that checking a displayed SUM then writing a movement prevents overselling. The current `atomicRecords` checks are bounded field predicates with `empty`/`notEmpty`, not arbitrary aggregate assertions or arithmetic updates. Prove that the proposed bounded record model can enforce capacity through the installed API; otherwise narrow the scope or use a dedicated stock owner. Do not invent a SQL endpoint or workflow expression function.

## Discover and build in dependency order

1. Run `cld apps list --json`, then `cld grids list --json`. Confirm the intended Base or create a dedicated one with the user's authorization. Avoid changing a similarly named production Base by assumption.
2. Inspect `cld grids templates list --json`. `templates instantiate inventory --empty --json` creates the complete configuration without sample records. Read the resulting tables, fields, Forms, Workflows and Apps; template updates do not rewrite previously created Bases.
3. Read `fields types`, `fields type <type>`, `records shape <table>`, `gql reference`, `workflows reference`, `apps reference`, and the document reference only as each becomes relevant. Keep the returned public IDs in a small local resource map; names are labels and can be ambiguous.
4. Create all tables, then fields and relations, then lookups/formulas, then sample records. Create Views, Forms, document/email templates and Workflows before the launchers and App that use them. App YAML is not a whole-Base deployment bundle.
5. Validate GQL, formulas and workflow YAML with the installed compiler. Pass JSON/YAML through files. Read every created resource back. If a multi-command build stops, continue from the returned IDs; blindly replaying creates can duplicate resources. Form submission and record import are not retry-idempotent.
6. Configure access and build the App draft. Run `apps validate`, `apps plan`, and `apps apply` using the syntax returned by command help. Review the derived capabilities; publish only after the intended audience journey is checked.

The CLI covers authoring; daily capabilities deliberately do not. Do not expect a schema-building or arbitrary workflow capability. App-only readers operate through `apps runtime`, without a raw Base grant.

## Keep state changes atomic and effects recoverable

Use `atomicRecords` for a decision based on current Grids records. Lock the same stable coordination record in every competing operation, check current state under that lock, and commit all related record changes together. An empty result has no row to lock: a reservation needs the shared item or other existing coordination record, not merely a check for absence.

For loans, a position starts Planned. Adding positions must coordinate on the same loan as approval and closing; the Inventory template only allows adding them while the loan is Requested. Issue checks the position, active loan and available item, then marks the position Issued and points the item at that exact position. Return checks that same link and records the return and condition while clearing the current allocation. Close checks that no unfinished positions remain. Never use an old loan's historical item list as authorization to return an item currently issued elsewhere.

Each workflow action is its own boundary; a sequence of `updateRecord` steps is not one transaction. Workflow expressions support references and `now()`, not general arithmetic or string interpolation in arbitrary fields. Use intermediate `setVariable` record references when traversing relations; do not guess unsupported multi-hop expression paths. Variables declared inside branches do not become outputs for later steps. Use `includes` for list membership and `contains` for text.

Record targets use typed references such as `inputs.item`. Relation field values and relation-filter operands instead use public IDs, for example `${{ inputs.item.recordId }}`; internal UUIDs and labels are not authoring values. Atomic checks support stored-field predicates, not computed Formula fields. Recheck the stored facts that establish the decision under the same lock.

Start external effects only after the business transition commits. A delivery state such as Ready → Processing → Sent distinguishes a claimed operation from confirmed success. Atomically claim Ready before document generation or email; a second independently started run must fail the claim. Reusing one invocation key protects retries of that invocation, not two different requests for the same business action.

If a run stops in Processing, inspect its original steps, Documents and email delivery before resetting state. Cancellation does not undo completed effects. A fresh run can create another immutable Document or email. Do not reset Processing automatically or present it as Sent. When an HTTP effect is uncertain, reconcile with the receiving owner; never assume that a timeout means nothing happened.

Inspect the installed email action before promising attachments or resending an existing Document. The built-in examples email a time-limited download link, not a PDF attachment. Such a link grants bearer access until expiry or revocation, so sharing it is an explicit audience decision. Separate legitimate deliveries need their own operation identity and must reuse the intended issued artifact instead of silently issuing a new invoice.

Configure Table Record changes to allow only the entry paths needed by the process. Forms own creation defaults and input validation; Workflow actions own status transitions. Keep those fields out of App `editableFieldIds`. Base writers still have broad access when direct editing is enabled; App visibility is not a substitute for server enforcement.

## Build the audience journey, not just a dashboard

Start with a task list, a hidden Record detail page, and a create Form. Add the fields, documents, comments and actions needed for that journey. Use stable local page/block IDs and returned public resource IDs. Record page parameters are required typed Record IDs; they are not arbitrary search or filter strings.

Bind list navigation with `ROW.id`, Form success with `RESULT.recordId`, and parent context with `PARAMS`. Prefer a fixed relation binding in a nested Form so users cannot accidentally attach a line to another parent. Use `AUTH.currentUser` for a signed-in claimant instead of asking them to pick their own identity. Server-run GQL and `availableWhen` enforce audience/state restrictions; hiding navigation does not.

App workflow actions must bind every required input; `inputMode: "prompt"` does not add an input dialog to an App button. To choose an item in a parent's context, use a Records block with a row action binding the item to `ROW.id` and the parent to `RECORD.id`. Do not leave a required record input unbound and assume the user will be asked for it.

Use Referenced records for an exact incoming relation, with bounded pagination and scoped row actions. Choose table versus cards for the work, give empty states a next action, and keep bulk work explicitly bounded. Embedded scanners support scalar session/after-scan prompts; record-picker prompts belong to the full scanner. Do not promise a stocktake or offline scanner without proving that workflow.

Base admins build resources. Base Write grants broad operational access. Customer, requester and staff Apps can be ordinary separately shared Apps; do not invent table grants or an admin-app type. Four-eyes approval groups do not themselves grant Base access.

Four-eyes Finalization prevents the person requesting finalization from approving that request. It does not compare the approver with an arbitrary claimant field. If someone submits on a claimant's behalf, enforce that additional business exclusion explicitly. Review is bound to the target Record's version, not recursively to all related lines or files on other Records. An invoice or claim header cannot certify unchanged child Records by itself. Design the submitted evidence and edit restrictions accordingly; immutable generated Documents retain their captured data, but do not finalize the live graph.

## Verify with realistic and adversarial examples

For each audience, check the published runtime using that audience's real authorized account. An admin-only successful preview does not prove customer isolation; do not grant broader access just to make a test pass. If no such account is available, report that verification gap.

- Empty Base, one normal record, long text and a multipage result.
- Reload and copied detail URL; malformed, missing, deleted and another user's Record ID.
- Required/fixed fields, direct-edit restrictions and denied workflow actions.
- Two independent competing business operations, not only the same idempotency key twice.
- Interrupted invocation, stale Record version and partial external completion.
- Partial returns/shipments/approvals where the scenario promises them.
- Document immutability, actual artefact type and explicitly supported renderer scope.

Use focused compiler/API/runtime checks first. Browser checks are needed for interaction claims that cannot be established there, not for every schema edit. Deliver resource links, a short operator guide and the exact verified versus unverified boundaries. Do not describe a syntactically valid draft as a completed inventory or ERP system.

## What the built-in templates provide

Every built-in template includes enabled Workflows, Document templates and at least one published Custom App. Each App exposes stored Documents on Record details through an exact template allowlist; generation remains an explicit workflow action or Base operation. Order and Transaction rows open their detail page, and their create Forms navigate there after submission. Template updates only affect newly created Bases.

- **Inventory:** individually labelled items, kits, loan requests, planned loan positions, atomic issue/return and closing, agreement delivery, labels and defect reporting. On a requested loan's detail page, staff add individual Items before approval. After agreement delivery starts the loan, they issue each position and return its current allocation by scanning. Every planned position must be issued and returned before closing; there is no partial cancellation action. Kits and manual availability confirmation do not enforce future booking intervals.
- **Bookshop:** itemised orders and an HTML invoice/dispatch example. Order details show lines, readiness, delivery state and generated invoices. Add lines from the overview, then review and release the order for invoicing. It is not stock control, payment collection or automatic E-Invoice issuance.
- **Finance:** transactions, categories/accounts, budgets and receipt delivery. Transaction details let users correct the recipient, process an expense and read its generated summary. This is not the merchant's original receipt, a claimant/approver reimbursement flow, bank reconciliation or a general ledger.
- **Document starters:** editable layouts. Preview and map their expected aliases, review wording and business data, and explicitly choose an E-Invoice renderer when needed. Layout text is not proof that a person approved an invoice or checked an identity.

All three delivery examples claim Processing before effects and mark Sent only after completion. Adapt these ordinary resources through their existing APIs. Review sample addresses and dates before any real send, and use an empty template when demonstration records would be misleading.
