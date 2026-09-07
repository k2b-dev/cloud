# Cloud Mail app design

Cloud Mail is a production-oriented shared inbox with a feature-complete IMAP/SMTP baseline, a provider-neutral domain model, local collaboration, structured automation, fast PostgreSQL search, and permission-checked interfaces for CLI, service accounts, and future AI agents.

Status: Living design. Last consistency review: 2026-07-21. This document separates the shipped generic IMAP/SMTP product from accepted follow-up architecture and the remaining release work.

## Contents

- [Decision status](#decision-status)
- [Implementation progress](#implementation-progress)
- [Generic IMAP release completion](#generic-imap-release-completion)
- [Remaining product gaps](#remaining-product-gaps)
- [Product direction](#product-direction)
- [System boundaries](#system-boundaries)
- [Connector architecture](#connector-architecture)
- [Domain model](#domain-model)
- [IMAP baseline synchronization](#imap-baseline-synchronization)
- [Commands and sending](#commands-and-sending)
- [Shared namespaces and sender identities](#shared-namespaces-and-sender-identities)
- [Search](#search)
- [Collaboration](#collaboration)
- [Workflow automation](#workflow-automation)
- [Agents and AI](#agents-and-ai)
- [Compose and rendering](#compose-and-rendering)
- [Application experience](#application-experience)
- [API and CLI](#api-and-cli)
- [Permissions and security](#permissions-and-security)
- [Background work](#background-work)
- [Operations](#operations)
- [Verification](#verification)
- [Delivery plan](#delivery-plan)
- [Alternatives](#alternatives)
- [References](#references)

## Decision status

This document uses two decision states:

- **Implemented contract** describes behavior that exists in the current schema, services, API or product UI. Changes require an explicit migration or compatibility decision.
- **Accepted direction** constrains the architecture unless a later decision explicitly replaces it.

| Area | Status | Direction |
| --- | --- | --- |
| Mail authority | Implemented contract | The connected provider owns portable mail state; PostgreSQL is a durable mirror and owns Cloud collaboration state. IMAP/SMTP is the mandatory baseline connector. |
| Primary resource | Implemented contract | Permissions, settings, automation, and sender identities attach to a Cloud mailbox. Its mailbox-owned connector binding provides upstream access behind it. Future AI policy uses the same resource boundary. |
| Connector strategy | Accepted direction | Ship the complete generic IMAP/SMTP product first. Add JMAP as the first enhanced connector, then Microsoft Graph and Gmail API without changing domain contracts. |
| Search and tags | Implemented contract | Field-specific structured search, native PostgreSQL FTS, and Cloud-local tags are mandatory; `pg_textsearch` is an optional ranking backend. |
| Conversations | Implemented contract | Original messages and replies form one mailbox-scoped conversation using provider IDs, RFC reply headers, conservative fallback, and explicit manual corrections. |
| Collaboration | Implemented contract | Assignment, work state, internal comment chat, shared drafts, activity, and presence are first-class mailbox features. |
| Draft continuity | Implemented contract | PostgreSQL owns the collaborative draft, a durable browser journal prevents lost typing, and one writer edits through a soft lease and revision checks. IMAP drafts are reconciled external snapshots, never a second silent authority. The implementation does not use Yjs or another CRDT. |
| Application experience | Implemented contract | The default workspace combines dense one-line conversation rows with a reader and at most one optional right detail panel. The conversation list can be hidden without leaving the workspace; only the composer has a dedicated full-size focus mode. Received attachments stay with their history message; outgoing attachments stay with the composer. |
| Automation | Implemented contract | Deterministic decision trees are the default. Live mail, schedules, direct invocation, and backfill use the same evaluator. Guarded automatic replies and reference allocation are workflow actions, not separate ticket or responder subsystems. AI remains a future typed decision node. |
| Bulk actions | Accepted direction | Agents compile broad mailbox requests into previewable one-shot workflow plans; direct unbounded mutation loops are not an execution path. |
| Shared folders | Implemented contract | Every Cloud mailbox has one mailbox-owned provider connection and one current binding. IMAP personal, other-user, and shared namespaces visible through that account are discovered like normal folders. Cloud does not merge the same server folder across users or share one user's provider authorization with another user. |
| Agent access | Accepted direction | UI, API, CLI, workflows, service accounts, and future AI tools use the same permission-checked domain services. |
| Permissions | Implemented contract | `read` includes mail reading and internal comments; `write` includes ordinary mail and collaboration operations; `admin` additionally owns connections, sharing, settings, workflows, policies, and mailbox deletion. Guided automatic-reply management may be delegated to writers by mailbox policy. |
| Storage and retention | Implemented contract | PostgreSQL stores all mirrored message bodies and attachment bytes. Mail content, collaboration history, tombstones, commands, and workflow runs are retained indefinitely. Future AI artifacts follow the same policy. Mailbox deletion is a reversible soft deletion and does not purge durable data. |
| External attachment links | Implemented contract | A mailbox admin can expose an existing message or draft attachment through a revocable opaque URL. Links optionally use a password, expiry, and download limit; each file is capped at 100 MiB and aggregate link-storage quotas remain out of scope. |
| Storage observability | Implemented contract | Cloud administrators get a non-enforcing `/admin/mail` overview of logical message, attachment, draft-upload, and link-share usage per mailbox plus global physical Mail database storage. Quotas, billing, and content drilldown remain out of scope. |
| Security boundary | Implemented contract | Only provider credentials and OAuth grants receive application-level encryption. Mail and collaboration data rely on normal enterprise database, backup, and access controls so search remains possible. Credentials are write-only and never retrievable, including by mailbox admins. |
| Release scope | Implemented contract | The current connector release supports generic IMAP/SMTP. Provider presets and managed Google or Microsoft OAuth improve setup but do not create provider-native sync contracts. |
| Connector and sync contracts | Implemented contract | Typed capabilities and remote identities, ImapFlow, Nodemailer, durable commands, recent-first backfill, and capability-driven fallbacks. |
| Data model and API names | Implemented contract | The current `mail.*` schema responsibilities and mailbox-scoped API routes are migrated and covered by integration tests. Future connector and AI additions extend these boundaries instead of replacing them. |
| Work states | Implemented contract | One assignee and one canonical `needs_action`/`waiting`/`done` state. Verified inbound mail selects `needs_action`; confirmed human replies select `waiting`; `done` is local collaboration state and never archives or moves mail implicitly. Snooze is an orthogonal visibility deadline. |

## Implementation progress

This snapshot records the verified Mail backend, CLI, and core application experience on 2026-07-21. It tracks delivered behavior, not architectural decisions; the delivery plan remains the source of truth for unfinished scope.

| Delivery slice | State | Implemented | Remaining |
| --- | --- | --- | --- |
| 1. Foundation contracts | Implemented | Mail package and schema; mailbox access adapter; encrypted write-only mailbox provider connections; one current remote-resource binding with retained historical fences; capability model; central execution resolver; durable command, outbox, job, lease, and fencing paths; conversation grouping with durable manual overrides; collaboration persistence; immutable conversation references; inline response timing; connector conformance harness; typed API and CLI. | No baseline architecture gap. Later connectors and AI must extend these contracts. |
| 2. IMAP onboarding, sync, and search | Backend and primary UI implemented | Generic manual IMAP/SMTP setup and live verification; provider presets and autoconfiguration; browser OAuth authorization-code PKCE for configured Google and Microsoft applications; encrypted refresh-token storage, distributed refresh locking, reconnect, and failure recovery; namespace, folder, subscription, and ACL discovery; recent-first resumable sync; UIDVALIDITY reset handling; body and attachment hydration into PostgreSQL; capability-driven QRESYNC/CONDSTORE/IDLE hints with bounded polling and periodic reconciliation fallback; listener health; bidirectional generic IMAP Draft projection with explicit conflict recovery; repair operations; canonical field-specific structured search with nested AND/OR/NOT, keyset pagination, URL state, native FTS and optional `pg_textsearch`; end-user Search builder; canonical saved views; mailbox-local tags; and explicit 20,000- and 100,000-message performance gates. | Enhanced provider connectors. |
| 3. Core mail operations | Backend, CLI, and primary UI implemented | Provider-backed folder administration and semantic roles; additive flags and keywords; move, copy, trash, archive, and delete commands; bounded atomic conversation triage and multi-selection; revision-safe drafts and streamed attachments; revocable public attachment links with optional passwords, expiry and download limits; aggregate Mail storage observability; sender lifecycle; send, Undo Send, Scheduled Send, SMTP delivery, streamed Sent append, ambiguous-outcome reconciliation, threaded message detail, manual conversation merge and split; message operation controls; compose/reply/reply-all/forward; selected-text quoting; isolated incoming HTML rendering; recognized quote collapsing; bounded image, PDF, text, audio, and video previews with safe download fallback; message-bound plus outgoing attachment UX; private and mailbox signatures/snippets; default signatures per sender identity; canonical preview/send rendering; and validated mailbox email CSS. | Provider-enhanced operations. |
| 4. Collaboration | Backend and primary UI implemented | Revision-safe assignment and canonical needs-action/waiting/done state; verified inbound and confirmed-human-reply transitions; orthogonal snooze with distributed due-time wakeup; chronological internal comments with replies, immutable revisions, and tombstones; personal reminders; durable cursor activity; built-in and private/mailbox saved views; horizontally safe ephemeral presence and advisory draft leases; visible editor presence; explicit draft takeover and recovery; provider-Draft interoperability with non-destructive concurrent-edit recovery; mailbox-scoped live invalidation; permission-safe API and CLI; and the combined Mail, ownership, comments, reminders, and audit Details panel. | Final accessibility and multi-browser revocation coverage. |
| 5. Deterministic workflows | Shared-kernel backend, CLI, and management UI implemented | Canonical YAML compiled and bound through `@valentinkolb/cloud/workflows`; metadata outside source; immutable saved versions; `messageReceived` and schedule activation; direct, one-shot, backfill, retry-child, and durable dry-run records; frozen targets and preconditions; configurable move, copy, send, draft, flag, notification, keyword, and collaboration budgets; permission and credential rechecks; durable command waiting; pause/resume, cancellation, targeted retry with lineage, and fenced recovery; provider keyword, move/copy/archive/trash/flag actions; assignment, status, local-tag and internal-comment actions; draft creation, scheduled draft delivery, notifications, immutable reference allocation, version-pinned inline response timing, and guarded RFC-safe automatic replies; typed API and CLI; and a dedicated Automations workspace with guided replies, references, version management, run controls, and history. | AI decision nodes and richer visual authoring. |
| 6. AI decisions and agents | Not started | Mail is exposed through typed API and CLI operations suitable for later tools. | Mail AI resource, tools, approvals, workflow decision nodes, summaries, classification, suggested drafts, and bulk-plan generation. |
| 7. Product-speed pass | Primary workspace implemented | Calm Cloud-native mailbox overview; resizable AppWorkspace navigation; dense one-line conversation rows; URL-backed SSR-first frontend navigation; collapsible conversation list; threaded reader; one combined and resizable Details panel; contained reply/forward composer; dedicated full-size and pop-out composer; durable local draft journal; complete structured Search authoring and saved-view reuse; bounded multi-selection and bulk actions; one command registry with configurable shortcuts; accessible folder picker; abortable detail navigation; bounded neighbour prefetch; stable focus and read-state behavior; permission-aware self-service settings; responsive empty/error states; and authenticated desktop/mobile verification against a live mailbox. | Final cross-browser accessibility and explicit frontend performance regression gates. |
| 8-9. Enhanced connectors | Not started | Provider-neutral connector, capability, identity, and command boundaries are established. | JMAP, Microsoft Graph, and Gmail API connectors and their conformance suites. |

Verification consists of package type checks, default tests, PostgreSQL integration tests, explicit large-mailbox performance gates, connector conformance, and authenticated browser smokes. The workflow suite covers immutable versions, preflight commitments, idempotent materialization, waiting, cancellation, recovery, authorization changes, event deduplication, and schedule fencing. The exact test counts are intentionally not duplicated here; the package scripts and CI output are authoritative.

## Generic IMAP release completion

The mandatory generic IMAP completion initiative is implemented through five independently verified workstreams:

1. **Provider Draft projection completed.** Accepted Cloud revisions are projected as complete MIME snapshots into the provider Drafts folder, and externally created or changed Drafts are imported into PostgreSQL. PostgreSQL remains the collaborative authority. Replacement UIDs are recorded before prior snapshots retire, and concurrent edits create explicit recovery copies instead of applying silent last-write-wins behavior.
2. **Capability-driven low-latency synchronization completed.** Bounded listeners use QRESYNC/CONDSTORE and IDLE hints where advertised. Push signals enter the existing durable sync pipeline; periodic reconciliation and polling remain active fallbacks. Distributed global, host, mailbox, and worker leases prevent horizontally scaled workers from committing stale state.
3. **Production reader completion delivered.** Sanitized incoming HTML renders in an opaque sandbox isolated from Cloud styles and scripts. Plaintext remains available, recognized quoted history collapses without deleting content, and supported image, PDF, text, audio, and video attachments receive bounded previews. Unsupported or signature-mismatched files remain explicit downloads.
4. **Complete structured Search UI delivered.** The bounded discriminated AST is exposed through one end-user builder for text fields, participants, dates, sizes, folders, attachments, references, tags, remote keywords, and collaboration state. Nested AND/OR/NOT, canonical URL state, saved-view reuse, validation, keyset pagination, and keyboard-accessible editing use the same public representation as API, CLI, and workflows.
5. **Release verification matrix exercised.** Unit and PostgreSQL integration suites cover permissions, cursor continuity, listener lease loss, reconnect and cleanup, Reader security fixtures, attachment limits, Search AST/UI/URL parity, saved-view migration, and Draft conflict recovery. Performance gates cover 20,000 and 100,000 messages. Two independent INWX generic IMAP/SMTP accounts verify real folder operations, MIME and attachment round trips, flags and keywords, move/copy/delete behavior, bidirectional Draft projection, concurrent-edit recovery, delivery, reconnect, and bounded fallback synchronization.

These workstreams reuse the current connector, command, job, cursor, authorization, and live-event boundaries. Provider-specific details stay inside the connector. Every background operation rechecks the current mailbox, binding, credentials, permissions, and remote rights before effects. There is no legacy Draft path, parallel synchronization authority, unbounded browser query, or provider callback that mutates projections directly.

## Remaining product gaps

The previously tracked public-link, storage-observability, operator-repair, workflow-control, browser-OAuth, Contacts-context, and productivity slices are implemented. The remaining product work is intentionally narrower:

- **AI decisions and agents:** Mail AI resource, permission-scoped tools, approvals, summaries, classification, suggested drafts, decision nodes, and generated bulk plans.
- **Enhanced connectors:** JMAP, Microsoft Graph, and Gmail API implementations and their connector-conformance suites.
- **Release hardening:** final cross-browser accessibility and revocation coverage, explicit frontend performance regression gates, and production OAuth application registration and tenant-policy decisions.

These later slices must use the same domain, permission, command, workflow, and connector boundaries rather than creating parallel execution paths.

## Product direction

Cloud Mail is not a thin webmail client and not a ticket system that happens to ingest email. The mailbox remains the primary resource, the provider remains authoritative for portable mail state, and Cloud adds a collaboration and automation layer around conversations.

The first release must use the production architecture. Later releases may expose more features, but they must not replace the sync model, permission model, search representation, or command journal.

### Primary users

- Individuals who need a fast general-purpose mail client.
- Teams that operate a shared office, support, recruiting, or administrative mailbox.
- Service accounts and agents that search, classify, route, draft, and act within explicit mailbox permissions.
- Administrators who configure connections, policies, shared signatures, workflows, and operational limits.

### Product principles

1. **IMAP baseline.** Generic IMAP/SMTP provides the complete first product, not a reduced compatibility mode. Portable actions stay visible in other clients where the server supports them.
2. **Provider-neutral core.** Remote IDs, cursors, rights, and submissions pass through connector contracts. Domain services never branch directly on IMAP, JMAP, Graph, or Gmail.
3. **Mailbox scoped.** Permissions, settings, workflows, sender identities, and AI policies attach to a mailbox resource. Transport credentials and OAuth grants belong to its write-only mailbox connection state and are never shareable resources.
4. **Collaborative by default.** Assignment, status, internal comments, shared drafts, presence, and activity are core domain concepts.
5. **Agent first.** UI, CLI, service accounts, workflows, and AI tools call the same typed domain queries and commands.
6. **Rules before models.** Deterministic conditions and actions work without AI. AI is an optional typed decision node in the same workflow pipeline.
7. **Fast by structure.** PostgreSQL mirrors searchable content, list queries use keyset pagination, and the UI keeps dimensions and focus stable.
8. **Every side effect is attributable.** User, service-account, workflow, agent, and system actions share command, permission, and audit boundaries.
9. **Read and send identities are separate.** Access to remote mail does not imply permission to send from its address.

### Goals

- Connect existing IMAP/SMTP mailboxes and remain usable during a resumable historical backfill.
- Deliver the same fast search, collaboration, workflow, AI, and command-first UX on a generic IMAP server.
- Handle at least 20,000 messages per mailbox without special operation, with verification fixtures at 100,000 messages and above.
- Preserve mail operations across compatible clients.
- Provide field-specific AND/OR/NOT search, saved views, labels, filters, and optional BM25 ranking.
- Let several people triage one mailbox without duplicate replies or hidden work.
- Group the original message and replies into a correctable conversation with an internal team-comment stream.
- Support deterministic workflows for new messages and historical backfill.
- Support generic conversation references and policy-bound automatic acknowledgements or out-of-office replies without introducing a separate ticket mode.
- Turn natural-language mailbox reorganization requests into bounded, previewable bulk-action plans.
- Support shared and other-user IMAP namespaces, per-folder rights, and separately authorized sender identities.
- Add JMAP, Microsoft Graph, and Gmail API as optional capability improvements without migrating Cloud mail data.
- Expose safe CLI and agent tools for the full mailbox workflow.
- Add summaries, classification, routing, and suggested replies without making the domain dependent on AI.

### Non-goals

- Running an SMTP or IMAP server.
- Replacing provider spam, antivirus, DKIM, SPF, or DMARC infrastructure.
- Pretending Cloud-only assignments, comments, and references are portable IMAP metadata.
- Exactly-once delivery over SMTP; the protocol cannot guarantee it after ambiguous disconnects.
- A general-purpose cross-application workflow framework in the first implementation.
- Simultaneous CRDT-based email drafting in the first implementation.
- Tracking pixels or external read receipts as a core feature.
- Physical purge or configurable retention expiry in the first release.
- Automatic sending or destructive actions without an explicit policy.
- Requiring JMAP, Graph, Gmail API, or provider administration for the first complete Mail experience.

## System boundaries

The architecture separates remote mail truth, durable Cloud truth, and transient coordination.

```text
                         +-----------------------+
                         |  UI / CLI / AI tools  |
                         +-----------+-----------+
                                     |
                            typed queries/commands
                                     |
                 +-------------------v-------------------+
                 |             Mail service              |
                 | authz | commands | workflows | audit  |
                 +-----+------------+-----------+--------+
                       |            |           |
             +---------v--+   +-----v------+   +v----------------+
             | PostgreSQL |   | Valkey     |   | Connector layer |
             | durable    |   | jobs/live  |   | IMAP/JMAP/APIs  |
             +------------+   +------------+   +--------+--------+
                                                         |
                                                +--------v--------+
                                                | Remote provider |
                                                +-----------------+
```

### Sources of truth

| Concern | Authority | Notes |
| --- | --- | --- |
| Container hierarchy and placement | Connected provider | PostgreSQL mirrors folders, labels, mailbox membership, and remote placement metadata. |
| Effective remote rights | Connected provider | IMAP ACLs, JMAP rights, Graph permissions, or Gmail scopes are mirrored for the current binding. |
| Standard flags and keywords | Connected provider | Capability-dependent and visibly distinguished from Cloud-only state. |
| Current remote existence and placement | Connected provider | The provider decides whether a message currently exists remotely and where it is placed. |
| Retained message content | PostgreSQL after import | Original headers, MIME structure and parts, normalized text, sanitized HTML, and attachment bytes remain durable even after provider deletion or access loss. |
| Submission acceptance | SMTP or provider submission API | Acceptance does not prove final delivery. |
| Allowed sender identity | Provider policy plus Cloud configuration | IMAP access alone never authorizes a `From` or envelope sender. |
| Assignment, work state, snooze, comments, and references | PostgreSQL | Cloud collaboration state. |
| Rules, signatures, snippets, saved views | PostgreSQL | Mailbox-owned configuration. |
| Permissions and approval policies | Cloud/PostgreSQL | Rechecked when commands execute. |
| Audit and activity | PostgreSQL | Append-only durable history. |
| Presence and reply indicators | Valkey | TTL-based and never authoritative. |

### Non-negotiable invariants

- Every remote object has a connector-scoped typed identity. IMAP uses folder identity, `UIDVALIDITY`, and UID; JMAP, Graph, and Gmail use their stable provider IDs. `Message-ID` is never a unique key.
- Every remote mutation originates from a durable command with an idempotency key and actor.
- Permission is checked when an operation is requested and again when delayed work executes.
- User expressions never contain or weaken the mailbox authorization predicate.
- Workflow and agent actions call domain commands; they do not call IMAP or SMTP directly.
- Agent-authored bulk plans are validated workflow definitions. The model cannot bypass preview, approval, effect budgets, or the command journal.
- Effective remote operations are the intersection of Cloud permission, current binding rights, sender-identity policy, and tool or automation scope.
- One central execution resolver validates the current mailbox binding for every remote operation. Domain services and connectors never implement their own credential-selection rules.
- A mailbox has at most one current provider connection and binding. Provider credentials are never user-owned, pooled, or reused across Cloud mailboxes.
- A command is pinned to one binding and credential revision when it starts and never changes either during a retry or ambiguous outcome.
- Remote identities, folder projections, sync cursors, and command history belong to the mailbox remote resource, not to the transient binding used for one operation.
- Live events invalidate or refresh durable state. Missing a live event never loses data.
- Audit metadata excludes credentials, full message bodies, attachment contents, and hidden model reasoning.
- AI output is untrusted until it passes a schema and the normal command policy.

## Connector architecture

Connectors translate provider state into one mail domain. The first release implements generic IMAP/SMTP completely. Optional connectors improve discovery, synchronization, and provider fidelity; they do not define separate product modes.

### Connector contract

The service layer depends on a typed connector interface with operations equivalent to:

```ts
interface MailConnector {
  discoverAccounts(): Promise<RemoteAccount[]>;
  discoverContainers(account: RemoteAccountRef): Promise<RemoteContainer[]>;
  discoverIdentities(account: RemoteAccountRef): Promise<RemoteIdentity[]>;
  getCapabilities(account: RemoteAccountRef): Promise<MailCapabilities>;
  syncChanges(cursor: SyncCursor | null): AsyncIterable<RemoteChangeBatch>;
  fetchMessages(ids: RemoteMessageIdentity[]): AsyncIterable<RemoteMessage>;
  apply(command: PortableMailCommand): Promise<RemoteCommandResult>;
  submit(command: SubmitCommand): Promise<RemoteSubmissionResult>;
}
```

The names are proposed, but the boundary is accepted. Domain commands never receive ImapFlow clients, JMAP method payloads, Graph objects, or Gmail resources.

Remote identity is a discriminated union:

```ts
type RemoteMessageIdentity =
  | {
      kind: "imap";
      folderId: string;
      uidValidity: string;
      uid: number;
    }
  | { kind: "jmap"; accountId: string; emailId: string }
  | { kind: "graph"; mailboxId: string; messageId: string }
  | { kind: "gmail"; userId: string; messageId: string };
```

Connector cursors and error metadata are similarly typed. Provider IDs remain opaque outside the connector and persistence mapping.

### Connector priority

| Connector | Product role | Initial scope |
| --- | --- | --- |
| Generic IMAP/SMTP | Mandatory baseline | Full mail UX, portable mutations, shared namespaces when advertised, and capability fallbacks. |
| JMAP | First enhanced connector after the generic release | Stalwart and Fastmail; stable IDs, state-based sync, push, multiple accounts, rights, identities, and native submission. |
| Microsoft Graph | Later provider connector | Exchange shared mailboxes, delegated folders, delta sync, and Send As/Send on Behalf semantics. |
| Gmail API | Later provider connector | Native labels, threads, history sync, sender settings, and Workspace administration paths. |

IMAP is not labelled legacy in the API or UI. The selected connector is operational metadata; users see available actions and clear setup requirements.

### Capability model

Connectors report typed capabilities such as:

- incremental state or cursor support;
- push or low-latency change hints;
- move, copy, delete, expunge, and folder administration;
- remote keywords, labels, and native thread IDs;
- shared account or namespace discovery;
- effective remote rights;
- sender identity discovery and native submission;
- server-side filter management.

Capabilities are persisted with verification time and source. Services ask for a capability and use a defined fallback; they do not branch on provider names.

| Capability | Preferred path | Baseline fallback |
| --- | --- | --- |
| Move | IMAP MOVE or provider move | Copy and mark the source deleted. Use UID EXPUNGE with UIDPLUS; otherwise leave the source `\Deleted` as `expunge_pending`. Never issue a mailbox-wide EXPUNGE. |
| Incremental sync | JMAP/Graph/Gmail cursor or QRESYNC | UID ranges, flag reconciliation, and periodic UID-set comparison. |
| Push | JMAP push, provider webhook, or IMAP IDLE | Adaptive polling plus scheduled reconciliation. |
| Folder roles | Provider role or IMAP SPECIAL-USE | One-time user mapping with remembered choices. |
| Remote tags | IMAP keywords or a connector-native non-container tag primitive | Cloud local tags. |
| Shared resources | JMAP account, Graph mailbox, or IMAP namespace | Discover resources exposed to the connected account; never infer equivalence across accounts. |
| Sender identities | Provider identity API | Explicit allowlisted identity and verification send. |
| Submission | JMAP or provider API | SMTP plus Sent-folder reconciliation. |
| Server rules | JMAP Sieve or provider filters | Cloud workflow engine. |

### Provider mapping

Stalwart Group principals expose a group inbox to members through IMAP and JMAP. That is the preferred Stalwart primitive for a functional shared mailbox. A Stalwart mailing list only distributes messages; an alias adds an address to an account or group. Neither is treated as a shared inbox. Stalwart's JMAP management extensions may later provision these objects, but that is an optional administrative integration.

Stalwart also supports JMAP for Sieve. Cloud workflows remain authoritative because they add backfill, collaboration actions, AI decisions, audit, and recovery. A deterministic subset may be compiled to Sieve only after semantic equivalence and ownership are defined; the initial release does not maintain two active rule engines.

Microsoft shared mailboxes are Exchange resources with separate Full Access, Send As, and Send on Behalf rights. Graph is the preferred enhanced connector. OAuth IMAP remains a valid compatibility path, including the shared-mailbox login form supported by Exchange Online.

Google has two distinct collaboration models. Gmail delegation grants access to one Gmail account. Google Groups Collaborative Inbox is a separate conversation product with assignments and resolution state, not a normal IMAP mailbox. The initial Gmail path is generic IMAP/SMTP; a later Gmail API connector adds native labels, threads, history, sender settings, and administrator-authorized access. Google Groups synchronization is outside the initial mail connector scope.

JMAP Core and JMAP Mail are stable IETF standards. JMAP Sharing defines common principals and notifications, while configurable JMAP Mail Sharing is still an active specification effort. Cloud may consume server-exposed shared accounts and rights without depending on unfinished client-side ACL management.

## Domain model

The durable schema lives under `mail.*`. Names below describe the current migrated schema unless a paragraph explicitly says that it belongs to a planned slice.

### Mailbox and access

`mail.mailboxes` is the only top-level Cloud resource. A newly created mailbox initially grants `admin` only to its creator and is shared through the normal Cloud permission system. It stores the user-visible name, collaboration policy, sync policy, search backend, default behavior, and aggregate health. It never stores provider credentials or provider-specific IDs directly.

`mail.provider_connections` stores one encrypted provider authentication context owned by exactly one Cloud mailbox. It is never a separate shareable or navigable Cloud resource and is not reused across mailboxes. At most one non-revoked connection exists per mailbox; revoked rows remain as historical command and audit references. Secret fields are write-only: APIs and mailbox administrators can see only whether a value is set, its verification state, and non-secret connection metadata. There are no global or user-owned mail credentials.

`mail.remote_resources` stores the mailbox-owned canonical remote account. It owns the connector kind, typed remote locator, discovered folder tree, sync state, and reconciliation generation independently of credential revisions.

`mail.provider_bindings` proves that one provider connection can reach one remote resource. It stores the authenticated provider principal, current capabilities and rights, verification evidence, health, and last use. Binding states are `pending`, `verifying`, `active`, `degraded`, and `revoked`.

Eligibility is derived centrally from binding state, verified account identity, current rights, operation, and sender identity; it is not copied into independent sync, automation, mutation, and submission flags. Cloud permission authorizes the actor, while the single current binding's remote rights cap every provider operation. Cached reads and Cloud collaboration remain available after provider loss; remote operations pause until a mailbox administrator reconnects the same provider account.

`mail.mailbox_access` links a mailbox to Cloud `auth.access` entries. The resource adapter follows the existing Cloud pattern for users, groups, and service accounts.

The `capabilities` JSON projection on `mail.provider_bindings` stores the capabilities advertised and verified for that binding. Authorization always resolves the acting user, current binding, operation, and target container. Capability discovery is data, not scattered conditionals.

`mail.remote_namespaces` stores personal, other-user, and shared IMAP namespace prefixes and delimiters as connector metadata for one binding. Binding-specific effective folder rights, their source, and verification time live on `mail.binding_folder_refs`; JMAP and provider connectors populate the same projection without inventing IMAP ACL strings.

`mail.sender_identities` stores an exact display name and `From` address, optional reply-to and envelope sender, default Sent/Drafts behavior, and `automation: disabled | mailbox`. Signature defaults reference the identity separately so personal and mailbox fallbacks do not become transport configuration. Interactive sends always use the mailbox connection. `mail.sender_identity_bindings` records which binding and provider principal passed the verification send; the record is revision-fenced and is invalidated after credential replacement.

One resolver owns binding selection:

```ts
type MailExecutionOperation =
  | "backgroundSync"
  | "actorRead"
  | "actorMutation"
  | "actorSend"
  | "automation";

resolveMailExecution({
  mailboxId,
  actorId,
  operation,
  target,
  senderIdentityId,
}): Promise<ResolvedMailExecution>;
```

Every remote operation resolves the one current mailbox-owned binding and rechecks its credential revision and target rights. Interactive sending additionally requires a current verification of the exact sender identity on that binding. Autonomous sending follows `automation`: `disabled` rejects the action and `mailbox` uses the same verified mailbox binding. Automation has no Cloud principal: it is attributed to the immutable workflow version and separately records the provider binding used as transport.

The resolver writes the binding ID, credential revision, and rights snapshot to the command before transport starts. They remain pinned for the command lifetime. An ambiguous mutation or submission is reconciled through its original binding and is never replayed after credentials change.

### Remote mail

`mail.folders` is the canonical mailbox-owned product projection of remote containers. It stores an internal folder ID, parent, user-visible name, role, discovery generation, and current sync cursor where the connector uses a container cursor. Connector-native mailbox or label membership maps to placements; a Gmail label is never duplicated as both a folder placement and a remote keyword.

`mail.binding_folder_refs` maps each canonical folder to the current binding's remote locator. It stores the provider object ID or IMAP path, delimiter, namespace, `UIDVALIDITY`, server subscription state, effective rights, and last verification. Historical refs remain attached to revoked bindings for command, sync, and audit evidence.

`mail.message_contents` stores immutable normalized message content:

- internal immutable content identity;
- RFC `Message-ID`, `In-Reply-To`, and `References`;
- envelope, internal date, size, selected headers, and MIME structure;
- normalized plain text and sanitized HTML;
- selected original headers and MIME structure;
- source hash, content hash, and hydration status.

`mail.message_part_blobs` stores each retained text, HTML, inline, and attachment MIME part once in content-addressed PostgreSQL chunks. Message and attachment rows reference these blobs instead of duplicating a complete raw MIME object and decoded attachment bytes. A source export is reconstructed from retained headers, structure, and parts; byte-for-byte preservation of the original transport source is not a first-release contract.

`mail.remote_message_refs` maps typed connector identities to mirrored content. For IMAP this includes folder identity, `UIDVALIDITY`, UID, and mod-sequence. JMAP, Graph, and Gmail store their opaque stable IDs and change metadata.

`mail.message_placements` stores remote container membership, flags, keywords or labels, and deletion state. One content row may have several placements. When a connector cannot prove cross-container identity, correctness wins over deduplication.

`mail.message_addresses` stores normalized sender, reply-to, to, cc, and bcc addresses with display names. This supports exact filters, fuzzy search, Contacts linking, and participant views.

`mail.attachments` stores MIME part identity, filename, content type, disposition, content ID, checksum, size, and a `mail.message_part_blobs` reference. Every attachment body remains in PostgreSQL indefinitely. Import, download, indexing, and backup paths stream chunks and never buffer a complete large attachment in one worker.

`mail.attachment_links` stores mailbox-admin-created, revocable public-download metadata for an existing message or draft blob up to 100 MiB. The `/share/mail/attachments/:token` URL contains a high-entropy token that is returned once; PostgreSQL stores only its hash. A link may have a password, expiry, and download limit. Short-lived grants count one logical download even when the recipient uses several HTTP range requests. Revocation, expiry, password state, and remaining downloads are rechecked before a grant and during streaming. Expired link metadata may outlive its detached blob reference for audit, but links never create a second copy of attachment bytes.

`mail.storage_usage_snapshots` and `mail.storage_system_snapshot` contain aggregate counts and byte estimates for `/admin/mail`. Reconciliation is queued and horizontally serialized. Received attachment bytes and public-link references are reported separately but are not added twice to logical mailbox storage. These snapshots provide observability only; the first release does not enforce mailbox or system quotas from them.

### Conversations and work

`mail.conversations` is a durable collaboration entity with rebuildable thread membership. It includes:

- derived subject and participant summary;
- latest inbound and outbound timestamps;
- optional primary human-readable reference projection;
- current assignee and canonical work state;
- snooze/reminder state;
- optimistic revision;
- last activity.

`mail.conversation_messages` links messages to one mailbox-scoped conversation. Threading prefers a connector's native thread ID, then RFC `References` and `In-Reply-To`, then a conservative normalized-subject fallback constrained by participants and time. A duplicate `Message-ID` never merges conversations by itself.

`mail.conversation_thread_overrides` stores audited manual merge and split decisions and outranks later heuristic rebuilds. A connector change or reindex therefore cannot silently undo a human correction.

A merge moves comments, notification delivery state, and non-conflicting personal reminders to the target conversation. If the same user has a reminder on both conversations, the target reminder wins and the discarded source delivery is retained as skipped audit state. A split keeps reminders on the source conversation and moves comments that reference selected messages with those messages.

`mail.conversation_comments` and `mail.drafts` store collaboration data. A comment contains Markdown/plain text, author, revision, optional parent comment, optional referenced message, and a deletion tombstone. Comment replies remain in one chronological stream rather than creating deeply nested trees. Draft revisions preserve authorship and prevent silent overwrites.

Every conversation also has an opaque technical ID used by storage, APIs, and URLs. It is never derived from or replaced by a human-readable reference.

`mail.reference_number_configurations` stores the one optional mailbox-scoped human-reference pattern, next sequence, enabled state, and whether new reply subjects include the reference. A pattern such as `SUP-{year}-{sequence:6}` is configuration, not a reusable scheme resource. `mail.conversation_references` stores each immutable allocated value with its pattern and configuration revision snapshot, conversation, allocation actor, and primary/alias role. A merge preserves both references, selects one primary, and keeps the other searchable as an alias. A split keeps the reference on the original conversation and gives the new conversation no reference until a user or workflow allocates one. The data model does not hard-code tickets as a product mode.

`mail.activity_events` is append-only user-facing history. `mail.commands` is the durable side-effect journal. These tables are related but not interchangeable: activity explains work to people; commands recover transport operations.

### Configuration and automation

`mail.saved_conversation_views` stores named structured searches and sort preferences with private or mailbox scope. `mail.local_tags` stores Cloud-only tags. Remote keywords remain on placements.

`mail.compose_templates` stores current Markdown signature and snippet definitions with a small Liquid-style variable syntax, optimistic revisions, ownership, and private or mailbox scope. Revisions fence concurrent edits and feed audit; they are not a user-visible immutable template history. `mail.compose_signature_defaults` selects a personal or mailbox fallback per sender identity, while `mail.compose_styles` stores validated mailbox CSS overrides.

Automatic-reply configurations and immutable workflow YAML store their own timezone, active date ranges, recurring office hours, and explicit holiday exceptions. Mail does not maintain a separate reusable response-schedule resource.

`mail.workflows`, `mail.workflow_versions`, `mail.workflow_runs`, and `mail.workflow_step_runs` store immutable automation definitions and execution history.

Explicit one-shot workflow runs use the same workflow definitions, versions, runs, targets, preflight commitments, and effect budgets as recurring workflows, but have a non-recurring lifecycle. The current bounded multi-selection UI instead submits the same checked conversation commands used by single-item actions, with fixed client concurrency and per-item failure reporting. Future AI-generated or otherwise broad plans must compile to an explicit one-shot workflow run rather than introducing a second unbounded executor.

The planned AI slice will add durable artifacts for summaries, classifications, routing suggestions, and reply suggestions with source revision, model profile, provenance, and invalidation state. No `mail.ai_artifacts` table or Mail AI resource is part of the current release.

## IMAP baseline synchronization

The generic IMAP/SMTP connector is the complete baseline implementation. Synchronization is a resumable state machine, not a periodic full import, and the application reads normal lists, conversations, and search results from PostgreSQL rather than blocking on live IMAP calls.

### Connector stack

- Nodemailer sends through SMTP.
- ImapFlow discovers folders, reads mail, watches changes, and performs IMAP mutations.
- MailParser's streaming API parses complete MIME sources when needed. Bulk paths must not use a buffering parser for large attachments.
- Provider-specific behavior is capability-driven. Gmail label support uses `X-GM-LABELS` and provider IDs when advertised.

### Connection onboarding

Setup begins with the email address and authentication method, not an IMAP form. The connector attempts, in order:

1. a maintained provider preset with OAuth where available;
2. DNS SRV discovery according to RFC 6186;
3. Thunderbird-style autoconfiguration and known-provider metadata;
4. a compact manual IMAP/SMTP form.

IMAP and SMTP verification run in parallel and report separate, actionable results. A successful test records TLS posture, capabilities, namespaces, special-use folders, and the authenticated principal. Credentials are encrypted only after verification succeeds.

After authentication, the user sees the folders exposed by that provider account. Server-shared or other-user namespace folders appear in the same folder discovery for that connection; they are not separate Cloud resources and cannot be shared independently. A normal connection creates and verifies a default sender for the account address unless the administrator explicitly disables that convenience. The setup flow asks only for unresolved choices: the remote scope to mirror and ambiguous Inbox/Sent/Drafts/Trash/Archive mappings. Advanced host, port, TLS, namespace, and folder fields stay collapsed unless discovery fails.

Missing protocol extensions change implementation details, not the available Cloud experience. For example, absent `SPECIAL-USE` triggers a remembered folder-mapping step, absent `IDLE` enables adaptive polling, and absent remote keywords leaves Cloud local tags available.

### Mailbox states

```text
disconnected -> verifying -> bootstrapping -> active
                     |              |           |
                     v              v           v
                auth_required    degraded    reconnecting
                     |              |           |
                     +--------------+-----------+
                                    |
                          connection_required
                                    |
                                  paused
```

Each state has a user-visible reason, last successful operation, and recovery action. A generic `sync failed` state is insufficient.

### Initial synchronization

1. Verify TLS, authentication, server identity, and advertised capabilities.
2. Discover folders and special-use roles.
3. Import current folder metadata and recent envelopes first.
4. Make the latest conversations usable while backfill continues.
5. Hydrate searchable body parts and attachment bytes in bounded, separately resumable batches from newest to oldest.
6. Record a durable cursor after each committed batch.
7. Reconcile flags, deleted UIDs, and folder counts before marking a folder current.

Bodies and attachment bytes have separate cursors so ordinary mail becomes usable before large attachments finish. Both are eventually mirrored to PostgreSQL and retained indefinitely. A body-dependent workflow waits for body hydration; it does not silently evaluate missing text as an empty body.

### Incremental synchronization

- Prefer QRESYNC and CONDSTORE with `HIGHESTMODSEQ` and `VANISHED` when available.
- Fall back to UID range fetch, flag reconciliation, and periodic UID-set comparison.
- Treat IDLE as a low-latency hint, not a durable event source.
- Keep one selected folder per IMAP connection. Active INBOX connections receive priority; other folders use bounded polling.
- Cap connections globally, per provider host, and per mailbox.
- Run periodic full reconciliation to heal missed events and provider anomalies.

### Binding leadership and fencing

The current binding is processed by one horizontally elected worker at a time using a short distributed lease and monotonically increasing fencing token for each remote-resource synchronization generation. PostgreSQL stores the current fence. Every batch transaction compares its token and updates projections and the durable cursor under the same row lock; a stale worker cannot pass a preflight check and commit afterward. Losing the lease stops further remote reads and commits; another instance resumes with the same current binding after the last committed transaction.

An in-flight command remains pinned to its original binding even when it degrades. Mutations and submissions with an ambiguous result never issue a retry after a binding or credential change. If the current binding disappears, local data and collaboration history remain available through Cloud permissions, background synchronization and remote commands pause, and mailbox health becomes `connection_required`. A mailbox administrator can then create a new connection and binding; revoked records remain immutable historical evidence.

### Folder discovery and subscriptions

IMAP namespace membership, mailbox visibility, and subscription are separate concepts. `NAMESPACE` identifies personal, other-user, and shared roots; `LIST` discovers currently visible mailboxes; `SUBSCRIBE` controls the server-side subscribed-name set returned by `LIST (SUBSCRIBED)` or legacy `LSUB`. A subscription is a display preference, not proof of read or write access.

Cloud never treats the subscribed list as the complete remote tree. Initial setup and periodic reconciliation list every mailbox visible to the authenticated account, compare it with the mailbox-owned folder projection, refresh effective rights, and classify each name as discovered, subscribed, selected for sync, unavailable, or removed. When `LIST-EXTENDED` is available, one listing may return subscription and child metadata; otherwise the connector combines ordinary `LIST`, subscription listing, and capability-safe probes.

Mailbox create, rename, delete, visibility changes involving lookup rights, and subscription notifications through IMAP `NOTIFY` are optional low-latency hints. The connector registers capability-safe mailbox and subscription notifications when supported. `NOTIFY` is not a complete `MYRIGHTS` change stream. Scheduled full-account discovery, pre-command rights refresh, and explicit refresh remain authoritative, and a rejected or overflowed registration falls back without changing behavior. Newly visible folders are discovered automatically; a mailbox admin may exclude folders from Cloud sync without issuing `UNSUBSCRIBE` unless they explicitly choose to change the provider-side subscription.

IMAP does not update subscriptions automatically when a mailbox is renamed, including child names. Rename reconciliation therefore matches stable provider identity where available, otherwise uses a bounded old/new-path comparison, updates the Cloud projection, and offers a separate idempotent provider-subscription repair.

### UIDVALIDITY and folder changes

A `UIDVALIDITY` change marks old placements stale and starts a controlled folder rebuild. The app attempts reconciliation through provider object IDs or conservative content metadata before removing stale rows.

Folder rename and deletion use provider object IDs when available. Path-only servers require a reconciliation window so a rename is not mistaken for delete plus unrelated create.

## Commands and sending

The provider-neutral command journal gives UI, workflows, CLI, and agents one recovery model. Connectors translate portable desired-state commands into the strongest supported remote operation.

### Command states

```text
queued -> executing -> confirmed
                  |-> failed
                  |-> ambiguous -> reconciled
                               |-> needs_attention
```

Commands contain actor, mailbox, target, desired end state, expected revision, idempotency key, correlation IDs, selected binding ID, rights snapshot, and transport metadata. Mutations express desired state rather than toggles, for example `seen = true` instead of `toggle seen`.

### Portable mutations

- IMAP uses UID-based operations exclusively and `MOVE` plus `COPYUID` when available.
- Without MOVE, IMAP copies and marks the source `\Deleted`. With UIDPLUS it uses UID EXPUNGE. Without UIDPLUS the first release leaves the source `\Deleted`, records `expunge_pending`, and reports degraded completion; no worker issues mailbox-wide `EXPUNGE` or `CLOSE` that could remove another client's deleted messages.
- JMAP and provider connectors use stable IDs, state preconditions, and native batch operations when available.
- Serialize conflicting commands per placement or conversation.
- Reconcile an ambiguous move before retrying; blind retry can duplicate mail.
- Activity records requested, confirmed, failed, and reconciled outcomes.

### Sending

Outgoing mail uses a durable outbox and a stable generated `Message-ID`.

```text
draft -> scheduled -> undo_window -> sending -> accepted -> sent_sync_pending -> sent
                                      |  |
                                      |  +-> failed
                                      +----> unknown -> reconciled_accepted -> sent_sync_pending
                                                   |-> reconciled_unsent -> failed
                                                   +-> needs_attention
```

The submission provider accepting a message does not prove final delivery. A disconnect near acceptance may leave the app uncertain. Before retrying an `unknown` send, the app searches remote Sent state for the stable `Message-ID` and provider identifiers. It retries only after proving the message was not accepted; an unresolved outcome moves to `needs_attention`.

The sender-identity binding records whether the provider saves sent messages automatically. For the IMAP/SMTP baseline, Cloud otherwise appends the exact generated MIME source to the detected Sent folder. This avoids duplicate sent copies.

Undo Send is a short durable delay before submission starts. Scheduled Send uses the same outbox with a future execution time. Both survive process restarts.

## Shared namespaces and sender identities

Shared folders are a standard IMAP concern, while sending as a functional address is a separate SMTP/provider concern. Cloud models both without pretending that one grants the other or that one user's provider session authorizes another user.

### Remote namespace model

IMAP `NAMESPACE` distinguishes personal mailboxes, other users' mailboxes, and shared mailboxes. Servers may expose several roots with different prefixes and delimiters. When `NAMESPACE` is unavailable, folder listing plus an optional administrator-supplied root provides a controlled fallback.

Folder discovery must not assume that every visible path belongs to the personal namespace or that `INBOX/` is the hierarchy root. A Cloud mailbox selects one discovered root or explicit subtree and recursively mirrors only that scope.

ImapFlow already performs namespace discovery and exposes normal folder listing. Standard ACL evaluation may require a small connector adapter if the pinned library version does not expose `MYRIGHTS` publicly. That adapter stays behind typed connector discovery and rights methods; no service, workflow, or agent uses undocumented protocol calls directly.

### Effective folder rights

When the server advertises the IMAP ACL extension, the connector reads `MYRIGHTS` for each selected folder and maps rights to typed capabilities such as:

- list and read messages;
- change seen or other flags;
- insert, copy, or move messages into the folder;
- mark deleted and expunge;
- create, rename, or delete child folders;
- administer ACLs.

Cloud does not need to edit upstream ACLs initially. It only consumes effective rights. If ACL is unavailable, successful read-only or read-write selection provides a conservative capability signal; destructive folder administration remains disabled unless explicitly verified.

Rights are refreshed during discovery, before delayed mutations, and after permission errors. Cloud permission authorizes cached reads and collaboration; remote operations remain capped by the current mailbox binding. Provider loss therefore cannot revoke Cloud collaboration access, and a stale mirror cannot authorize a new provider mutation.

IMAP shared and other-user namespaces are account-local provider state. If Alice's authenticated account exposes `Shared/Support`, that folder appears in Alice's Cloud mailbox and is synchronized with Alice's effective `MYRIGHTS`. Bob connecting his own account creates a separate Cloud mailbox projection, even if his server exposes a folder with the same path. Cloud does not attempt cross-principal folder equivalence, credential failover, or folder-level sharing. A team that needs one collaborative Cloud mailbox connects a functional mailbox or another deliberately shared provider account and then shares the Cloud mailbox through normal Cloud permissions.

Folder administration uses one hierarchy and one durable command path. Mailbox administrators can create personal top-level folders and permitted subfolders, rename or delete eligible folders, and change the provider subscription. The settings UI derives these capabilities from current namespace and rights data; the command runtime rechecks the pinned binding immediately before every provider effect. Shared and other-user folders without authoritative ACL evidence are fail-closed for destructive administration.

Cloud sidebar visibility is a mailbox-local property of the canonical folder and is independent from provider access, IMAP subscription, and synchronization eligibility. Hiding a folder removes its entire visible subtree from normal navigation without deleting mail, changing provider state, or discarding each child's preference. Missing and ambiguous folders remain visible to administrators for diagnosis but never appear in ordinary mailbox navigation. Special-folder mappings remain separate selections over active, selectable folders.

### Sending identities

A sending identity is an allowlisted, mailbox-scoped sending context, not a free-form `From` field. It contains:

- an internal label that helps collaborators distinguish roles without exposing implementation details to recipients;
- recipient-visible display name and exact `From` address;
- optional `Reply-To` and envelope sender;
- default Cc recipients and one mailbox default signature;
- interactive and automation authentication policy, verified submission binding, and authenticated provider principal;
- Drafts and Sent folder mappings;
- verification state and last provider rejection.

Several identities may use the same `From` address. This supports roles such as private and business contexts without conflating their label, defaults, folder mappings, or verification state. There is no separate alias or legacy sender model.

The provider decides whether a binding may submit mail using an identity. SMTP has no portable discovery command for this authorization. Configuration requires an exact `From` allowlist entry and a successful test send through each eligible binding; a successful IMAP `MYRIGHTS` check never marks an identity as authorized. A later provider rejection invalidates that binding's verification until it is tested again.

The envelope sender defaults to the visible `From` address. A different envelope sender is allowed only through a provider preset or a separately tested exact configuration; it is never free-form compose input.

Reply defaults use a verified identity whose address received the original message. A unique match is selected automatically; a default identity resolves duplicate matches, while an unresolved duplicate requires an explicit choice. The composer always shows the internal identity label together with the recipient-visible sender. Changing it is limited to configured identities; arbitrary sender spoofing is not supported.

Default Cc recipients are materialized only when a person creates an interactive draft. They remain editable and are not injected into workflow or automatic-response drafts. The mailbox default signature is likewise inserted only when a new message is created. A personal signature override takes precedence, and changing identity settings never silently rewrites an existing draft.

Sent-copy behavior belongs to the identity. A functional address can therefore authenticate to SMTP with a person's account while placing the resulting sent copy in a shared Sent folder when the provider permits both operations.

### Provider-exposed shared folders

Generic IMAP may expose functional or delegated folders in an authenticated user's shared or other-user namespace. Cloud discovers those folders with the rest of that account and stores their subscription state and effective rights. They are not separate Cloud resources and cannot be shared independently from the mailbox.

Provider subscription changes made by another client or administrator are reflected after rediscovery. Mail does not silently subscribe every newly exposed shared folder: an administrator can subscribe or unsubscribe explicitly in folder settings, while Cloud sidebar visibility remains a separate local choice.

This deliberately does not reproduce Thunderbird's cross-account Shared Folder setup. If Alice and Bob each connect personal university accounts, each gets an independent Cloud mailbox projection of what that account can see. Cloud does not claim that similarly named folders are the same remote resource and does not fail over from Alice's credentials to Bob's. If Alice loses university access, only Alice's mailbox loses provider connectivity; its PostgreSQL mirror remains readable to existing Cloud collaborators and remote operations pause.

For a durable collaborative team mailbox, the supported setup is a functional provider mailbox, delegated account with stable service credentials, or provider-native shared mailbox connected as one Cloud mailbox. The Cloud mailbox can then be shared through normal `read`/`write`/`admin` permissions. Sender identities still require explicit SMTP verification because IMAP folder rights do not prove permission to send as the functional address.

## Search

Search supports a simple global query and a structured Thunderbird-style expression over separate fields.

### Search expression

```ts
type MailSearchExpression =
  | { type: "and" | "or"; expressions: MailSearchExpression[] }
  | { type: "not"; expression: MailSearchExpression }
  | { type: "text"; field: TextField; query: string; match: "words" | "phrase" | "contains" | "exact" }
  | { type: "date"; field: "internal_date" | "sent_at"; operator: DateOperator; value: string }
  | { type: "size"; field: "message" | "attachment"; operator: SizeOperator; bytes: number }
  | { type: "work_status"; value: "needs_action" | "waiting" | "done" }
  | { type: "snoozed"; value: boolean }
  | { type: "assignee"; userId: string | null };
```

`TextField` covers `any`, subject, body, sender and recipient roles, combined recipients and participants, message ID, attachment name, internal comment, conversation reference, provider folder, Cloud-local tag, and remote keyword. The public schema defines field-specific operators and values. The API limits nesting depth, clause count, aggregate query text, and individual string size. It never accepts raw SQL, PostgreSQL query syntax, or regular expressions.

The simple search box compiles to an `or` expression over subject, body, sender, recipients, attachment names, internal comments, and conversation references. Advanced search exposes field, operator, value, and match-all/match-any controls. The discriminated AST is the only accepted search representation; no legacy parser or parallel query language is retained for Mail search.

Authorization always wraps the user expression:

```sql
WHERE mailbox_id = ANY($authorized_mailbox_ids)
  AND (<compiled search expression>)
```

`$authorized_mailbox_ids` is an effective-access set, not a caller-provided filter. It follows current Cloud permission. Provider connectivity does not grant or revoke access to mirrored content; it only gates remote synchronization and mutations.

### Search documents

Search storage keeps body, subject, sender, to, cc, bcc, combined recipients, participants, attachment names, internal comments, and conversation references separately. Reference lookup uses an exact index; comment text participates only for users who can read the parent mailbox. A combined `search_text` projection powers broad relevance ranking.

Native PostgreSQL search is mandatory:

- weighted `tsvector` columns with GIN indexes;
- `websearch_to_tsquery` and phrase predicates;
- `pg_trgm` for addresses, names, subjects, and typo tolerance;
- exact B-tree indexes for structured filters;
- keyset pagination by date, rank bucket, and stable ID.

### Optional pg_textsearch

If `pg_textsearch` is already installed, preloaded, and healthy, `mail.search_backend = auto` selects its BM25 index. The modes are `auto`, `postgres`, and `pg_textsearch`.

The app does not install extensions or edit `shared_preload_libraries`. It keeps the native GIN path in every environment and does not combine `pg_textsearch` with another competing `bm25` access-method extension.

Implementation targets the latest stable PostgreSQL release supported by the latest stable `pg_textsearch` release at the time the schema is frozen. CI pins that resolved pair and records the exact database, extension, dataset, and hardware profile used for reproducible search benchmarks; development branches or unreleased extension builds are not release gates.

BM25 ranks broad text candidates. Native indexes still implement field-specific filters, phrases, facets, and exact predicates. Backend-specific scores stay internal because BM25 and `ts_rank` are not comparable contracts.

### Result behavior

- Search can sort by relevance or date.
- Results state whether historical body indexing is still incomplete.
- Facet counts respect the same mailbox permission and search expression.
- A backend fallback may change ranking but not matching, permission, or pagination semantics.

## Collaboration

Collaboration state attaches to a conversation, not to individual messages.

### Work states

The work states are:

- `needs_action`: shown as **Needs action**; the team needs to review or act;
- `waiting`: shown as **Waiting for reply**; the team's next step depends on someone else;
- `done`: no current action remains.

A newly verified inbound message always selects `needs_action` and clears snooze. A confirmed human reply or reply-all selects `waiting`, including a reply synchronized from another client through RFC reply headers. New messages, forwards, automatic replies, retries, failures, and ambiguous delivery outcomes do not infer a new state. A manual state remains until a later qualifying message. Marking a conversation `done` is always local collaboration state: it never moves or archives remote mail. Unread remains a separate IMAP flag and is never used as a task state.

One user is the current assignee. The mailbox itself is the team queue, so multiple assignees are not required initially.

### Collaboration views

Built-in saved views include Needs action, Mine, Unassigned, Waiting for reply, Done, Snoozed, and Recently Active. **Waiting for reply** is a team work state. **Snoozed** is a time-based visibility filter that leaves the work state unchanged. A distributed due-time job clears elapsed snoozes, while new inbound mail clears them immediately. The sidebar places Snoozed in a separate Follow-up section so these concepts do not look interchangeable. Counts represent conversations requiring work, not only unread messages.

Custom views store the same bounded filter contract. Private views belong to one user; mailbox views are shared and require `write` to create, edit, or delete. Dynamic filters such as `assignee: me` resolve for the current actor when the view runs.

### Comment chat

Internal comments are never sent to recipients or stored as remote message bodies. They form a permission-scoped chronological chat attached to the conversation. Comments support revisions, deletion tombstones, and an optional reply or message reference. Reply references provide context without turning the chat into a nested discussion tree.

New comments invalidate the durable conversation projection through the live topic. Editing or deleting a comment preserves actor and revision history in activity without storing every keystroke.

The UI must make internal comments visually unmistakable from email. A comment composer can never address an external recipient, and the mail reply composer can never silently switch into comment mode.

### Shared drafts

Drafts store source Markdown/plain text, intent, source-message context, authorship, last editor, and revision. Preview is derived from the current source through the canonical renderer rather than stored as another editable authority. They belong to the mailbox rather than their creator: a reader can inspect the complete draft, including Bcc recipients, and comment on its conversation; a writer can edit, take over, discard, schedule, or send it. Draft creation and autosave do not notify the mailbox. Review requests use the existing internal comment and mention flow.

Every editor opens a durable draft URL. New messages, replies, forwards, and standard `mailto:` intents create or resolve the draft before navigating to the composer. Subsequent edits are written immediately to a durable browser recovery journal and saved as coalesced PostgreSQL revisions. Reload, browser restart, and temporary network loss never discard a draft. Returning to the mailbox keeps the draft; discard is a separate explicit soft-deletion action with recovery. The UI distinguishes saving, saved, offline, and conflict states without announcing routine successful autosaves.

PostgreSQL is the authoritative collaborative state after a revision is accepted. The browser journal covers edits that have not reached PostgreSQL and is removed when the draft is sent, explicitly discarded after its recovery period, or becomes inaccessible. Access revocation closes active editors and clears their local readable copy. A best-effort save on blur or page hide improves convergence but is never the only recovery mechanism.

The first implementation has one active editor per draft, not simultaneous multi-cursor editing. Opening the draft route acquires a soft lease. Other collaborators see the latest accepted revision read-only and may explicitly **Take over**. A takeover makes the prior editor read-only; any unaccepted local text remains a recoverable copy instead of being merged or overwritten. The focused page, its explicit pop-out, and same-user browser tabs all address the same logical draft rather than becoming competing draft records.

Presence and reply leases use distributed TTL state. Every heartbeat and snapshot rechecks current mailbox access; revoked users disappear immediately, and another eligible writer may recover their stale lease without waiting for the TTL.

Saving requires the expected draft revision. A stale save produces a typed conflict that preserves the user's version as a copy and offers the latest accepted revision; the first implementation does not merge text automatically and does not use Yjs or another CRDT. Routine autosaves update draft revision history but do not create one user-facing activity event per save. Activity records meaningful lifecycle events such as creation, requested review, takeover, discard or restore, scheduling, and send.

Send, Reply, Reply all, and Forward operate on one exact frozen draft revision. Permission, sender identity, provider binding, recipients, rendered signature, and conversation context are rechecked before submission. The first successful idempotent submission wins; every stale editor becomes read-only. Activity distinguishes authorship from delivery, for example **Drafted by Alice, sent by Bob**. A newer inbound message or another collaborator's sent reply marks the draft context as changed and requires review rather than silently deleting or rewriting the draft.

### Activity

Every user-visible collaboration lifecycle mutation appends one `mail.activity_events` row in the same database transaction as the projection update. Draft text autosaves remain in draft revision history and do not emit activity per revision. Remote actions append requested and terminal events around the durable command.

Actors support:

- user;
- service account;
- mailbox workflow;
- system reconciliation.

The future AI slice may add an agent actor with an optional delegated user, but current activity and command contracts do not pretend that actor kind already exists.

Events include target, before/after metadata, outcome, timestamp, and correlation IDs. A short user-visible reason is allowed. Hidden reasoning and message bodies are not.

Activity and comment chat remain separate projections. Routine assignments, moves, and sync events belong to activity and do not flood the human conversation. A relevant activity subset may be shown inline behind a filter.

Credential changes, binding changes, mailbox sharing, sender-identity changes, and workflow or automatic-send activation also write a security-relevant event through the Cloud platform audit service. Future AI bulk-plan approvals will use the same audit boundary. Mail activity remains the user-facing operational history; platform audit does not replace it.

## Workflow automation

Mail workflows are deterministic programs compiled from canonical YAML by the shared Cloud workflow kernel. Mail owns authoring metadata, immutable versions, mailbox permissions, target selection, preflight commitments, persistence, trigger delivery, domain actions, and audit. The shared kernel owns strict YAML parsing, diagnostics, expressions, recursive control flow, bound plans, dry-run traversal, step execution, waiting, and restoration.

### Canonical source and metadata

YAML contains only `inputs`, optional automatic `triggers`, and `steps`. Name, description, numeric ordering priority, activation state, immutable version IDs, and effect budgets are stored outside source.

```yaml
inputs:
  message:
    type: mailMessage
    required: true
  conversation:
    type: mailConversation
    required: true

triggers:
  messageReceived:
    with:
      message: "${{ trigger.message }}"
      conversation: "${{ trigger.conversation }}"

steps:
  - if:
      all:
        - contains:
            - "${{ inputs.message.subject }}"
            - invoice
        - not:
            equals:
              - "${{ inputs.conversation.workStatus }}"
              - done
    then:
      - addKeyword:
          message: "${{ inputs.message }}"
          keyword: Finance
      - moveMessage:
          message: "${{ inputs.message }}"
          folder: Invoices
      - setConversationStatus:
          conversation: "${{ inputs.conversation }}"
          status: waiting
```

Source is preserved exactly, while the immutable version also stores source, manifest, catalog, and compiler hashes plus the compiled IR and bound plan. Literal accessible folder and user references bind to stable IDs. Creating new source creates a new immutable version and does not rewrite the active version or historical runs.

### Inputs, conditions, and actions

The current inputs are `mailMessage` and `mailConversation`. Message fields include subject, sender/recipients, hydrated bodies and attachments, folder, flags, keywords, direction, and timestamps. Conversation fields include assignment, canonical `workStatus`, revision, and latest-message time. The binder checks reference roots, paths, and value kinds before a version is stored.

Conditions use the shared recursive operators `equals`, `notEquals`, `contains`, `startsWith`, `endsWith`, `exists`, `all`, `any`, and `not`. Steps support actions, `if`/`then`/`else`, and `switch`/`cases`/`default`. The shared parser understands bounded `forEach`, but Mail rejects it because mailbox target batches belong in the durable target coordinator.

The implemented action vocabulary is deliberately bounded:

- `addKeyword` and `removeKeyword` create durable provider commands;
- `moveMessage`, `copyMessage`, `archiveMessage`, and `trashMessage` create durable provider commands against bound semantic or explicit folders;
- `addFlag` and `removeFlag` change standard message flags through the same command journal;
- `assignConversation` performs a revision-checked collaboration transaction and accepts `null` to unassign;
- `setConversationStatus` sets `needs_action`, `waiting`, or `done` transactionally;
- `addLocalTag` and `removeLocalTag` change mailbox-local conversation tags transactionally;
- `addComment` adds an internal, actor-attributed conversation comment;
- `ensureConversationReference` atomically allocates one immutable mailbox reference from the enabled mailbox reference configuration;
- `createDraft` creates an unsent normal-delivery draft and exposes it to later steps;
- `scheduleDraftSend` schedules that draft through the ordinary durable outbox;
- `notifyUser` sends a bounded internal notification to a current mailbox reader;
- `automaticReply` creates a guarded workflow-owned reply draft and sends it through the durable command and outbox path, with a pinned sender and optional inline response schedule;
- `succeed` and `fail` stop the current target with an operator-facing message.

AI decisions are not current workflow actions. The language intentionally keeps unbounded loops and arbitrary provider calls outside the workflow runtime.

### Invocation and triggers

Omitting `triggers` creates a direct-only workflow. Any saved workflow, including one with automatic triggers, can be invoked manually through UI/API/CLI channels. Mail exposes `invoke`, `oneShot`, and `backfill` run kinds; they currently share the same version-pinned query, preflight, frozen-target, and execution path, with the kind retained for audit and caller intent.

`messageReceived` is the implemented automatic path. Live incremental sync records one deduplicated event only after a stable inbound message is linked to a conversation. Historical sync/backfill does not emit the trigger. Dispatch selects active registrations by mailbox and trigger kind, ordered by ascending numeric priority and stable IDs, and materializes at most one run per activation and delivery key.

The language manifest accepts `schedule` with a five-field cron and optional IANA timezone. Activation reconciles stable Mail-prefixed scheduler registrations. Every due slot revalidates the active revision and schedule, derives a deterministic slot key, and enters the same authorization-aware materialization path as event triggers. Scheduler delivery is transport; PostgreSQL activation and run state remain authoritative.

### Preflight, dry-run, and effect budgets

Mail preflight is the supported no-effects review contract. It runs in a repeatable-read, read-only transaction and uses the shared dry-run traversal against frozen message and conversation snapshots. It keyset-pages the mailbox-scoped target query, rejects required body/attachment data that is not hydrated, counts only planned changes, and enforces the immutable version's effect budget.

The response contains the version ID and identity, source and query hashes, effect budget, action counts, target count, and a `preflightHash`. Execution repeats preflight before creating the run and rejects a stale hash. Large backfills then keyset-page the same target query in bounded transactions, persist the cursor and rolling digest after every batch, and publish targets only after the final count and digest match the commitment. The hash commits the caller to the version, bound catalog, inputs, query, target identities, source preconditions, planned action counts, and budget.

Default version budgets are 1,000 targets, moves, copies, sends, drafts, and notifications plus 2,000 flag, keyword, and collaboration changes. Schema ceilings are 50,000 targets, moves, copies, sends, drafts, and notifications and 100,000 flag, keyword, or collaboration changes; preflight also caps total planned effects at 50,000. Versions created before an effect budget existed fail closed for the corresponding action. The API accepts an explicit complete budget object. The CLI exposes the same bounds on workflow and version creation.

The shared runtime `dryRun` mode is exposed through the Mail API and CLI. It creates a durable run with frozen targets and per-target planning results, but action planners receive no effect-capable ports. Preflight remains the stateless execution commitment; a durable dry run is the auditable no-effects record.

### Authorization and activation

Reading and validation require mailbox `read`. Creating versions and activating or deactivating require `admin`. Preflight, execution, and cancellation require mutation access. Creation and execution require a durable current user or service-account credential.

Activation requires the expected current version ID, replaces the workflow's trigger registrations, records who activated it, and grants the active version mailbox-owned automation authority. Deactivation requires the expected active version ID, clears the active pointer, and disables its registrations without changing existing runs. Manual runs retain actor-bound durable credentials and recheck current mailbox access. Automatic runs do not depend on the activating administrator retaining personal access; they remain authorized only while the exact workflow version is active. Each provider or collaboration effect rechecks mailbox identity, active-version fencing, capabilities, and mutable preconditions.

### Waiting, recovery, and audit

Provider actions create idempotent commands keyed by target and step. A non-terminal command parks the step on a `mail.command` dependency. Body, HTML, and attachment references can park automatic runs on `mail.hydration`. Completion events wake parked targets quickly; PostgreSQL reconciliation remains authoritative when an event is missed.

Targets and trigger events use leases and monotonically increasing execution generations. Stale workers cannot finish a step after losing a lease. Completed outcomes are restored instead of repeated. Periodic recovery resumes stale keyset materialization checkpoints, requeues queued targets and expired claims, and resolves terminal command or hydration dependencies. Revoked actors or mailbox permissions cancel unfinished materialization. Failed commands fail the step; ambiguous provider outcomes become `needs_attention` and are not blindly retried.

Runs retain pinned source identity, target progress, inputs/query, actor authorization snapshot, outcomes, and error state. Activity and platform audit record lifecycle requests and effects with workflow, version, trigger, run, and action attribution.

### Current product surface

The Mail UI exposes guided out-of-office, office-hours acknowledgement, and custom automatic-reply flows in the mailbox **Automations** workspace. The same workspace keeps references, canonical YAML versions, activation, recent runs, pause/resume, cancellation, and targeted retry available to mailbox admins without mixing them into everyday mailbox settings. A targeted retry creates a new immutable child run with explicit lineage and only eligible failed targets; it never rewinds a provider effect in place. Response timing lives directly in a guided reply or its immutable YAML action. There is no visual workflow editor. AI decisions, conflict analysis, and generated bulk-plan UX remain product work and must not be presented as available behavior.

## Agents and AI

This section is the accepted architecture for a future Mail AI slice. The current release provides the typed API, CLI, service-account authorization, deterministic workflows, and audit boundaries that AI tools will call, but it does not register a Mail AI resource, AI tools, decision nodes, summaries, or suggestions yet.

Agent access will be a projection of the same mail domain, not a parallel backend.

### Interactive chat

The mailbox will register a `defineAiResource` definition. Its access hook resolves the current mailbox permission for every request. Resource hooks define the system prompt, model policy, and tools.

`defineAiTool` will wrap typed mail services. The existing Cloud AI runtime owns Nessi streaming, resumable turns, frontend tools, approvals, persisted always-allow preferences, and AI tool-call audit.

An AI tool attempt and approval will share agent-loop and tool-call correlation IDs with the resulting mail command and activity event. The AI audit proves what was proposed and approved; the mail command proves what actually executed.

### CLI and service accounts

The current agent-facing foundation is the typed Mail API and CLI. Service accounts receive the lower of mailbox permission and service-account scope. Command handlers never receive raw provider credentials; a service-account owner may configure its own provider connection only through the same write-only secret API used by users.

The future AI tools will expose a bounded subset of existing queries and commands:

- search conversations with the structured search AST;
- get a bounded conversation projection;
- list activity;
- assign, tag, move, and set status;
- create and update shared drafts;
- add internal comments;
- read or ensure a conversation reference where policy allows;
- send or delete with policy checks;
- draft, validate, and preview bulk-action workflow plans;
- execute a specifically approved one-shot plan;
- save, activate, and run recurring workflows where permission allows.

All commands accept an idempotency key. Mutations that depend on current collaboration state accept an expected revision.

### Planned tool approvals

Default policies:

| Tool class | Default |
| --- | --- |
| Search, read, summarize, suggest | No approval |
| Generate or preview a bulk-action plan | No approval |
| Assign, tag, status, comment, create draft | User-configurable resource approval |
| Move, archive, trash | One-time approval, optionally resource-configurable |
| Execute a bulk-action plan | One-time approval bound to plan hash, target snapshot, and effect budget |
| Send and permanent delete | One-time approval; no implicit always-allow |
| Background assignment, local tag, status, comment, or draft | Mailbox-admin policy bound to workflow version and action scope |
| Background flags, move, archive, or trash | Mailbox-admin policy with folder scope, target constraints, and effect limits |
| Automatic reply | Separate automatic-send policy and hard Core ceilings |
| Background arbitrary send or permanent delete | No blanket authorization; requires a specifically approved bounded plan or later dedicated policy |

Interactive remembered approvals remain bound to user, app, mailbox resource, tool, and approval scope. Interactive agents execute as their caller or explicit delegated principal. Autonomous workflows and background agent runs have no Cloud principal; an immutable mailbox policy authorizes a workflow version and bounded action scope, while activity records the workflow and provider transport separately.

### Planned AI artifacts

Summaries, labels, routing suggestions, and reply suggestions will record:

- source conversation revision and content hash;
- model profile and workflow/tool provenance;
- created and invalidated timestamps;
- output schema version;
- optional short explanation and confidence metadata.

A new message will invalidate stale summaries and suggestions. Generated drafts will remain visible as drafts but show that their source context changed.

### Prompt injection boundary

Email content and attachments are untrusted data. They cannot alter system prompts, permissions, tool policy, approval state, recipient validation, or workflow definitions.

AI decision nodes will have no tools. Agent tools expose bounded, paginated results and fetch bodies or attachments explicitly. The app never stores hidden chain-of-thought.

### Skills and external agents

Future Mail skills may provide versioned workflow instructions such as:

- morning briefing;
- end-of-day wrap-up;
- batch draft writer;
- unanswered-thread review;
- contact or organization history;
- mailbox cleanup proposal.

An MCP adapter can later expose the same tool contracts to external agents. It does not get a broader permission model than the native CLI or AI resource.

## Compose and rendering

Compose starts with plain text and Markdown while producing standards-compatible MIME.

### Draft representation

- Store source plain text or Markdown in PostgreSQL with revision history and keep only unsynchronized recovery state in the browser journal.
- Generate `text/plain` and sanitized `text/html` MIME alternatives from an exact accepted revision.
- Preserve remote IMAP draft placement and `\Draft` state through coalesced complete MIME snapshots. A successful new snapshot is recorded before the prior remote snapshot is deleted or marked deleted.
- Treat Cloud-to-provider synchronization as projection and provider-to-Cloud synchronization as import and reconciliation. The flow is bidirectional but intentionally asymmetric: PostgreSQL remains the collaborative authority.
- Persist connector-scoped remote identity and the last projected Cloud revision. IMAP uses mailbox identity, `UIDVALIDITY`, UID, and a content fingerprint; JMAP uses its stable email ID and state tokens where available.
- Import a draft created in another client as a Cloud draft. If only the remote version changed, import it as a new revision. If Cloud and the provider both changed, retain the remote version as a conflict copy instead of merging or choosing a winner silently.
- Treat remote deletion as a Cloud soft discard only when the provider still represents the last projected Cloud revision. If Cloud has newer work, preserve it and expose a synchronization conflict.
- Attribute changes that arrive through an external client to that external provider binding when the protocol cannot identify the human editor. Never claim a specific Cloud actor without evidence.
- JMAP may improve identity and state-based conflict detection, but it does not change the PostgreSQL authority, permission, activity, or frozen-send contracts.

### Reply quoting and draft intents

A reply can quote a complete prior message or selected lines from any message in the conversation. Selecting text exposes **Quote in reply** and inserts a localized attribution plus a standards-compatible quote block at the current composer cursor:

```text
Am 11.07.26 um 18:12 schrieb Valentin Kolb:
> Der 30.07. nachmittags passt bei mir gut. Teilst du mir dann noch Ort und genaue Uhrzeit mit?

Der genaue Prüfungstermin ist:

30.07., 15:05 Uhr, Raum O27/341.
```

Users can write before, after, or between several quoted fragments. Plain-text output uses `>` prefixes; sanitized HTML uses semantic quote markup. The draft keeps enough source-message metadata to regenerate attribution without modifying the retained message or changing `In-Reply-To` and `References` behavior.

Each mail draft has one explicit intent: `new`, `reply`, `replyAll`, or `forward`:

- `new` starts without a source message or recipients;
- `reply` addresses the selected message's reply target and preserves reply headers;
- `replyAll` adds the selected message's visible recipients, removes the active sender identity and actor addresses, and deduplicates normalized addresses;
- `forward` starts with empty recipients, a `Fwd:` subject, and the selected message as forwarded content. It includes that message's non-inline attachments by default, but each attachment can be excluded before sending.

Forward acts on the selected message, not the entire conversation. **Forward as attachment** is an explicit advanced action. A reply or forward may be opened from a message action, keyboard command, or command palette.

Every compose action first materializes a durable draft and then opens its canonical route, `/app/mail/:mailboxId/compose/:draftId`. The workspace never embeds a second editor. A draft can be handed off to a dedicated browser window only after pending changes are persisted and the current editing lease is released; both windows still refer to the same draft rather than cloning it. Internal comments are collaboration records edited only in the Details panel. They are never a mail draft intent and never appear in the mail composer.

The composer keeps only frequent controls visible: sender and recipients, subject, body, the primary intent action, delivery options, attachments, and the new-window control. Formatting and Markdown preview, signatures and snippets, scheduling, and discard live in focused toolbar or overflow actions. Future AI drafting will use the same progressive-disclosure boundary. Provider-dependent priority flags and **Forward as attachment** remain advanced actions. Undo send is a post-send action, not another composer mode.

The primary commit action mirrors the draft intent: **Send** for a new message, **Reply** for reply, **Reply all** for reply-all, and **Forward** for forward. Its icon follows the same intent. The adjacent secondary control is consistently named **Delivery options** and contains scheduling or delivery behavior; it never changes recipients or draft intent.

### Standard email links

Cloud Mail accepts browser and operating-system email intents through `/app/mail/compose?mailto=<encoded-mailto-uri>`. The mailbox-independent landing page lets the user choose a writable mailbox and one of its verified sender identities, creates an ordinary durable draft, and redirects to the canonical draft route.

The intent accepts bounded standard recipient, Cc, Bcc, subject, and body fields. It never accepts a sender identity, attachments, or an instruction to send automatically. Unsupported fields are ignored, malformed or oversized intents fail closed, and recipients are normalized and deduplicated before draft creation.

Mailbox tools can ask a compatible browser to register Cloud Mail as its `mailto:` handler. This is an explicit, device-local browser choice; Cloud does not claim that the registration succeeded, persist a misleading account preference, or replace operating-system settings.

### Signatures and snippets

Mailbox signatures and team snippets support an explicit allowlist of Liquid-style variables such as `{{ actor.display_name }}`. Logic tags, filters, dynamic partials, arbitrary variable paths, and Bcc values are intentionally unsupported. This keeps copied signature source editable inside an otherwise ordinary email body, leaves unrelated braces literal, and lets Markdown and plaintext apply the correct escaping rules.

Definitions can be private to one user or shared with the mailbox. Mailbox admins manage shared definitions; writers manage their own private definitions. Variables include explicit mailbox, actor, sender, and message fields. Missing required variables block preview and sending and identify the field.

When a new message draft is created, its selected personal default signature, or the mailbox fallback, is copied into the editable Markdown body exactly once as variable source. The writer can move, replace, or remove it. `/signature` commands insert the same raw source as an invisible, persistent template segment, while ordinary `/snippet` commands resolve variables immediately and insert concrete editable content in the draft's format. Preview and send resolve placeholders only inside these signature segments using the actual current actor; braces typed or quoted elsewhere remain literal.

Mandatory corporate or legal content is intentionally not modeled as a signature; a future compliance footer is a separate send policy. Definitions and CSS use optimistic revisions and audit instead of user-visible version histories. Queueing a send freezes the rendered HTML and plaintext in the outbox snapshot, so later edits to the draft, definition, actor profile, or mailbox CSS cannot rewrite queued or sent output.

### Mailbox CSS

Mailbox CSS styles outgoing Markdown HTML only. A minimal readable built-in stylesheet is always applied. Mailbox-admin overrides are parsed, bounded, and allowlisted; imports, active URLs, at-rules, unsafe selectors, and unsupported properties fail closed. Supported declarations are inlined for email-client compatibility. Write, Preview, and resize-only Split views render through the same pipeline used to freeze send output.

Incoming HTML never uses mailbox compose CSS.

## Application experience

The app uses `AppWorkspace` as a dense operational workspace, not a landing page. The default is calm through progressive disclosure: capabilities remain available without occupying the screen until needed.

```text
+----------------+---------------------------+--------------------------+------------------+
| Mailbox nav    | Conversation list         | Reader                   | Optional detail  |
| Views/folders  | sender · subject · preview | thread · message actions | one panel only   |
| Settings       | state · assignee · time    | message actions          | resizable        |
+----------------+---------------------------+--------------------------+------------------+
```

### Workspace hierarchy

The left navigation selects the mailbox, saved view, or provider folder. Navigation and conversation-list widths are resizable, collapsible, and remembered per user. The conversation list favors Notion Mail-style one-line rows so users can scan many messages without changing context. A row keeps sender, subject, preview, unread state, timestamp, attachment indicator, and compact collaboration signals such as assignee or waiting state. Secondary labels yield before sender, subject, or work state disappears.

Selecting a row opens the conversation beside the list. Search, filter, and view controls stay compact. Row actions appear on selection or hover, but consequential state and commands remain keyboard-accessible and never depend on hover alone.

### Thread view

The conversation view shows the original message and every inbound or outbound reply in chronological order. The newest relevant message is expanded; older messages remain compact but preserve sender, recipients, timestamp, attachment presence, and delivery direction. Recognized quoted history is collapsed for readability, while the unmodified raw body remains available.

The selected message exposes familiar **Reply**, **Reply all**, and **Forward** actions without opening a generic action drawer. Each action creates or selects a durable draft and opens the focused composer route. Older messages keep the same commands in their message menu.

Internal comments do not enter the email chronology. They live in the optional Details panel beside ownership, compact mail metadata, and recent activity. Its comment input cannot address external recipients. The mail composer cannot silently switch into internal-comment mode.

A stable conversation reference, when allocated, appears as a compact copyable label in the header and search results. Manual merge and split commands are available only when threading is wrong, require confirmation, and append an activity event. Merge previews the primary reference and retained aliases. Split previews which conversation keeps the reference and whether the new conversation receives one.

### Detail panels

The reader can open one resizable `AppWorkspace.Detail` panel at a time. A single **Details** panel combines ownership, canonical next-step state, snooze, internal comments, recent activity, workflow state, participants, routing metadata, labels, and compact message metadata. Team and Mail details are not separate panels. Technical headers remain an advanced disclosure inside Details rather than occupying another panel.

Contact context and contextual AI may replace Details in the same optional panel region. The AI panel hosts contextual chat and actions; the quiet inline summary remains in the reader. Attachments remain with their source message and do not become another generic detail panel.

A badge on Details represents unread internal comments only, uses the exact unread count, and disappears at zero. Participant, attachment, and activity counts are not mixed into that badge.

Closing a panel restores reader width. Panel choice, width, and visibility are user preferences, not conversation data. On narrow screens a detail panel becomes a dedicated overlay or route and keeps an explicit path back to the conversation.

### Attachment placement

Attachments remain visually bound to their origin. Received files appear beneath the exact history message that carried them, including filename, type, size, availability, and actions. Files being sent appear only inside the active composer with upload progress, retry, remove, and failure state. The UI never combines received and outgoing files in one generic drawer.

Each attachment group has a stable source label such as **Received with this message**, **Attached to this reply**, or **Included from original message**. The label remains visible in ordinary reading mode and is not dependent on opening an attachment-specific state.

Opening a received file starts from its message row and may use an inline preview, a focused preview surface, or a new browser tab according to file type. Opening or downloading still rechecks current mailbox permission. The attachment's source message remains visible or directly reachable from the preview.

### Reader width and compose focus

The normal split workspace is optimized for moving between conversations. The conversation list can be hidden and restored independently while mailbox navigation and conversation actions stay in place. Hiding the list closes the optional detail panel and lets the reader use the remaining workspace width; it is not a separate reader mode. List visibility and width are remembered per user, and restoring the list preserves the selected conversation and reader scroll position.

**Focused composer** is the only mail editing surface for new messages, replies, reply-all drafts, and forwards. It occupies the complete app viewport: mailbox navigation, conversation list, reader, conversation toolbar, detail panels, and other workspace chrome disappear. The composer header is the topmost UI, identifies the current mail intent, and provides **Back to mailbox** and **Open in new window**. It never offers Internal note as a mode. The dedicated browser window contains the same composer-only route for comparison with other mail or applications. Leaving the composer persists current editable content before releasing its draft lease.

### Command-first interaction

One command registry powers buttons, menus, the shared Spotlight-style command palette, and keyboard shortcuts. Commands declare availability, required permission, label, icon, shortcut, and execution handler.

Shortcuts are discoverable and configurable. Keyboard and pointer interaction have parity. International keyboard layouts are part of verification.

Triage actions advance focus to the next conversation without resizing the list. Adjacent conversation data is prefetched. Optimistic feedback appears immediately, while durable command state exposes sync failures and recovery.

Dragging a conversation onto a provider folder invokes the same checked move command as menus, keyboard shortcuts, CLI, and agents. The drop target shows whether the operation moves, copies, or is unsupported before release. Every drag action has an equivalent keyboard and command-palette path.

### Split views

Superhuman-style Split Inboxes become saved views over the structured search AST, not folders. Built-in and team templates may combine ordinary filters and AI-produced local tags.

The UI recommends a small visible set and lets users reorder or hide empty views. A conversation may appear in several views because views are queries.

This is selective product inspiration, not protocol emulation. Cloud keeps its own mailbox permissions, audit model, IMAP portability, collaboration semantics, and accessible keyboard/pointer parity.

### Summary placement

The planned AI summary will appear as one quiet line below the subject and expand in place. It will not occupy a separate card or panel. Stale or unavailable state will remain visible without blocking the thread.

### Reminders

Snooze returns a conversation at a time. Conditional reminders return it only if no reply arrives. A new inbound response cancels an `if no reply` reminder and reopens the conversation.

### Automatic-response setup

**Automations** is a first-class mailbox workspace rather than a settings tab. Its overview and **Automatic replies** section offer acknowledgement and out-of-office presets, but saving a preset creates an ordinary versioned workflow. There is no second responder engine or hidden provider rule. Mailbox admins get focused **Workflows**, **Runs**, and **Reference numbers** pages instead of one mixed advanced screen. Response timing belongs to the automatic reply or the workflow action that uses it; there is no separate schedule catalogue.

Setup selects a verified sender identity, content, timezone and schedule, deduplication policy, and suppression defaults. Before activation, the UI previews the exact subject and body with sample data and summarizes which automated or list messages will be suppressed. The Automations overview shows the active reply, which can be reviewed or disabled with one audited action.

**Settings > Access** contains the mailbox policy for guided replies. The secure default is admin-only. An administrator may allow writers to create and change automatic replies so employees can manage their own absences. This delegation does not grant sender-identity administration, conversation-reference administration, or YAML workflow administration.

### Contact context

Normalized external addresses resolve through a typed Contacts integration without copying contact ownership into Mail. Mail excludes its own active sender identities, while Contacts rechecks its current book permissions and returns a bounded participant projection plus an exact match summary that remains correct across pagination. The Details panel groups one or multiple readable contacts by participant, shows related mailbox history, and offers **Add as contact** only for addresses with no current match.

Contact creation remains owned by Contacts. Mail opens a validated Contacts deep link in a new tab with only the participant name and email. Contacts then uses its existing writable-book picker and upsert panel: one writable book is selected directly, multiple books require an explicit choice, and no writable book produces a permission explanation. The create form treats the display name as an editable label rather than guessing first and last name. Contacts live invalidations refresh Mail after creation. Mail does not link conversations to whole Spaces; that coarse association was removed because it did not identify actionable project context.

### Intentionally deferred UX

- External guest sharing of full conversations.
- Tracking pixels and recipient read-status feeds.
- Simultaneous real-time text merging.
- Smart Send timing.
- Calendar scheduling inside Mail.
- A cross-mailbox unified inbox beyond permission-scoped saved views.

## API and CLI

The Mail package owns a typed Hono API and service layer. Frontend islands use the generated client for Mail-owned JSON routes. The permission-scoped Contacts integration calls its owning app contract instead of reading foreign tables.

### Resource shape

The API is mailbox-scoped except for provider discovery/OAuth metadata, Cloud-admin observability, the Same-Origin live socket, and the intentionally public attachment-download surface. Representative current routes are:

```text
/api/mail/mailboxes
/api/mail/mailboxes/:mailboxId/connections
/api/mail/mailboxes/:mailboxId/bindings
/api/mail/mailboxes/:mailboxId/folders
/api/mail/mailboxes/:mailboxId/sender-identities
/api/mail/mailboxes/:mailboxId/conversations
/api/mail/mailboxes/:mailboxId/conversations/:conversationId/comments
/api/mail/mailboxes/:mailboxId/conversations/:conversationId/context
/api/mail/mailboxes/:mailboxId/messages/:messageId
/api/mail/mailboxes/:mailboxId/search
/api/mail/mailboxes/:mailboxId/drafts
/api/mail/mailboxes/:mailboxId/scheduled-sends
/api/mail/mailboxes/:mailboxId/commands
/api/mail/mailboxes/:mailboxId/workflows
/api/mail/mailboxes/:mailboxId/workflow-runs
/api/mail/mailboxes/:mailboxId/automatic-replies
/api/mail/mailboxes/:mailboxId/reference-number-configuration
/api/mail/mailboxes/:mailboxId/compose-templates
/api/mail/mailboxes/:mailboxId/attachment-links
/api/mail/mailboxes/:mailboxId/activity
/api/mail/oauth/providers
/api/mail/mailboxes/:mailboxId/oauth/start
/api/mail/admin/operations
/api/mail/admin/storage
/api/mail/ws
/share/mail/attachments/:token
```

Conversation and message routes remain under a mailbox so authorization cannot be omitted accidentally.

### CLI shape

```text
cld mail create "Support"
cld mail use <mailbox-id>
cld mail provider add --name Support --email support@example.org --username support@example.org --imap-host imap.example.org --smtp-host smtp.example.org --secret-stdin
cld mail binding attach <connection-id>
cld mail identity setup-default
cld mail search --query query.json --json
cld mail conversation messages <conversation-id>
cld mail conversation merge <target-id> <source-id> --target-revision 3 --source-revision 2 --yes
cld mail conversation split <conversation-id> --message <message-id> --revision 4 --yes
cld mail conversation update <conversation-id> --assignee <user-id> --revision 4
cld mail comment add <conversation-id> --body-file comment.md
cld mail reference config set --pattern 'SUP-{year}-{sequence:6}' --include-in-reply-subjects
cld mail reference ensure <conversation-id>
cld mail draft create --identity <sender-id> --to recipient@example.org --body-file reply.md
cld mail send --identity <sender-id> --to recipient@example.org --body-file message.md --wait
cld mail attachment link create <message-id> <attachment-id> --source message
cld mail operator status
cld mail admin storage show
cld mail workflow validate --source-file route-mail.yml --mailbox support
cld --json mail workflow preflight <workflow-id> --version-id <version-id> --mailbox support --query-file query.yml
cld --json mail workflow run backfill <workflow-id> --version-id <version-id> --mailbox support --query-file query.yml --yes
```

Human output is concise; `--json` returns stable machine-readable contracts. Commands never print credentials or unrestricted message bodies by default.

Natural-language organization commands and generated bulk-plan approval are future AI/product surfaces, not shipped CLI commands.

The authoritative workflow command reference is `skills/cloud-cli/references/mail.md`; executable help from `cld mail workflow help` defines the shipped command grammar.

## Permissions and security

The mailbox is a Cloud resource with standard permission levels.

### Permission mapping

Accepted mapping:

| Permission | Capabilities |
| --- | --- |
| `read` | List, search, and read mail and shared drafts; download permitted attachments; view activity; write, edit, and delete own internal comments; mention collaborators. Draft access includes envelope fields and Bcc because drafts are mailbox content. |
| `write` | Read plus every ordinary message and collaboration operation: flags, keywords, moves, copy, archive, trash, message deletion, local tags, assignment, status, references, draft creation and editing, takeover, discard, and send. A mailbox policy may additionally delegate guided automatic-reply management. |
| `admin` | Write plus mailbox-owned provider connections, all mailbox binding links, sender identities, remote folder creation/rename/deletion, mailbox settings, sharing, workflows, rules, policies, signatures, and reversible mailbox deletion. |

Service-account credential scopes can only reduce resource permission. Tool and automation policies can reduce it further.

A provider connection is controlled by mailbox administrators. They may see redacted connection and binding health and replace or revoke the credential, but can never retrieve, inspect, or export an existing secret value.

### Layered authorization

An operation is allowed only when every relevant layer permits it:

```text
Cloud mailbox permission
  intersect current rights and scopes of the mailbox binding
  intersect sender-identity authorization when sending
  intersect tool, workflow, or service-account scope
  intersect approved one-shot effect budget when the operation uses one
```

Cloud permission authorizes access to the mailbox and mirrored content. Remote operations additionally require the current mailbox binding and can never exceed its provider rights. Conversely, provider access does not grant Cloud access unless the mailbox resource is shared with the principal.

Current multi-selection actions may be executed by a writer only for commands that writer could perform individually, and every target is checked independently. Explicit one-shot workflow runs apply their frozen preflight and effect budget in addition to the actor's current permission. Future generated bulk plans will use that same path. Recurring rules, connection changes, sender identities, and autonomous-action policies require mailbox administration permission.

Manual conversation merge and split require `write` and an expected conversation revision. Automatic-reply creation, activation, sender selection, deduplication, and embedded schedule changes require either `admin` or `write` when the mailbox's guided-reply policy explicitly delegates them. Sender-identity configuration, references, and arbitrary workflow changes still require `admin`. Execution uses the frozen workflow version and a resolver-selected eligible transport binding.

### Revocation

Every request, attachment fetch, stream reconnect, delayed command, workflow action, and agent tool execution resolves current access. Revocation blocks new work immediately. Existing live clients refetch and lose inaccessible state; draft editors close and clear their durable browser recovery journal for that resource.

Binding rights, scopes, and remote resource visibility are also rechecked. If a remote folder disappears or loses read rights, synchronization and provider commands for that folder stop. Cached mail and collaboration remain governed by the Cloud ACL.

System sync jobs resolve the mailbox's one current eligible binding and hold a fenced sync lease; they are not owned by the user who originally configured that binding. User-configured workflows become mailbox-owned when an admin activates an immutable version. They have no Cloud principal, but every execution records the workflow version, trigger, selected transport binding, provider principal, and resulting command.

### Credential security

- Apply application-level encryption only to provider password, app-password, OAuth token, and equivalent secret fields in provider connections. Connections never become mailbox permissions.
- Return only redacted configuration state such as `isSet`, verification status, provider principal, and last verified time. No API, CLI, UI, administrator, or original creator can retrieve a stored secret.
- Support password/app-password, manual OAuth2 token, and managed authorization-code forms. Secret values may be submitted from the setup UI but are never returned to the browser after storage.
- Require TLS and certificate validation by default.
- Redact protocol logs and disable raw wire logging in production.
- Audit credential create, replace, verify, and revoke operations.

### Endpoint SSRF

Mail setup is self-service, including custom IMAP and SMTP endpoints. Every configured endpoint passes through a central outbound policy that rejects private, loopback, metadata, and disallowed DNS targets.

DNS rebinding and redirects must be considered; hostname validation alone is insufficient.

### Message rendering

- Parse incoming HTML as untrusted content.
- Sanitize server-side and render with isolation and a restrictive content policy.
- Block remote images by default and offer per-message or per-sender loading.
- Disable scripts, forms, objects, imports, and active URL schemes.
- Serve CID images and attachments through permission-checked endpoints.
- Set safe download headers and never infer trust from filename extensions.

### Searchable content encryption

Native PostgreSQL full-text search requires the database engine to read message text. Message bodies, attachments, search documents, comments, activity, and workflow data therefore use normal PostgreSQL storage without application-level field encryption. The enterprise deployment relies on database access controls, infrastructure encryption where configured, backups, and limited operational access; this is not a zero-trust storage design.

## Background work

`@k2b/sync` supplies NATS-backed coordination; PostgreSQL stores domain progress and audit. Cloud-owned rate limits continue to use Valkey.

| Primitive | Use |
| --- | --- |
| `scheduler` | Periodic mailbox discovery, reconciliation, reminders, cleanup, and repair scans. |
| `job` | Folder backfill, body hydration, workflow target, and outgoing-send work. The future AI slice will use the same primitive for artifact generation. |
| `mutex` | One conflicting sync or command pipeline per mailbox/folder/placement and one sync-leader election per remote resource. |
| Cloud `ratelimit` service | Provider-host and mailbox request budgets in Valkey. |
| `topic` | Best-effort UI invalidation with cursor replay. |
| `ephemeral` | Viewing, composing, and reply-presence leases. |
| `retry` | Bounded transport retries for known retryable failures. |

Jobs are at-least-once. Inputs contain IDs and version keys, not full message bodies. Processors load current permission, state, and definition from PostgreSQL.

When the AI slice ships, Nessi will handle model loops, structured output, tool execution events, and approvals. It will not replace queue claims, workflow runs, idempotency, or mail audit.

## Operations

### Mailbox health

The current mailbox Status and operator projections expose:

- mailbox health and pause state;
- active, degraded, pending, revoked, and last-verified provider bindings;
- effective-rights sources and connector capability counts;
- folder discovery generation, active/missing/ambiguous/subscribed counts, and per-folder sync state;
- last synchronization, lag, and recent running or failed sync runs;
- hydration, search-index, and conversation-thread coverage;
- command, outbox, workflow, automatic-reply, and suppression state counts;
- attention commands with redacted error codes and only the safe repair actions currently available;
- configured versus effective search backend and `pg_textsearch` fallback state;
- whether conversation references are configured and how many have been allocated.

The Cloud-admin operations page exposes a bounded, cursor-paginated aggregate across mailboxes. It contains redacted IDs, counts, states, timestamps, and coverage only; it does not expose provider endpoints, subjects, addresses, filenames, bodies, or credentials.

### Repair operations

Implemented mailbox-admin operations include:

- synchronize the mailbox or one eligible folder;
- rediscover provider folders, namespaces, rights, and capabilities;
- verify an eligible binding;
- rebuild one active folder after a projection or `UIDVALIDITY` problem;
- hydrate missing message bodies;
- rebuild search chunks or conversation links without deleting source messages, manual thread overrides, collaboration state, or references;
- reconcile an ambiguous provider effect without blindly replaying it;
- retry or cancel only failed or queued provider-read maintenance work whose provider effect did not start;
- inspect, pause, resume, cancel, and create a targeted retry child for eligible workflow runs;
- replace or revoke the mailbox connection, verify sender identities, and pause or resume mailbox transport through their dedicated settings flows.

Action eligibility is computed on the server and explains why unsafe or duplicate work is disabled. Every accepted manual operation is audited and enters the same durable command or workflow handlers as automatic work. Force-expiring a sync leader, provider-subscription repair, automatic-reply decision inspection, and inverse-plan generation are not current operator actions and must not be presented as shipped controls.

### Observability

Operational projections currently cover synchronization and hydration progress, connector and push state, command/outbox/workflow queues, automatic-reply outcomes and suppressions, search and thread coverage, reference allocation, attention commands, and storage. Production metrics should additionally cover sync duration and lag, fetch bytes, reconnects, parser failures, discovery and rights refreshes, binding failures, command latency, ambiguous outcomes, search latency, index size, workflow throughput, automatic-reply sends, reference allocation failures, and identity rejections. AI call, cost, and approval metrics begin only with the AI slice.

Logs use IDs and counts rather than subjects, addresses, bodies, or credentials. Current traces carry mailbox, command, workflow-run, and request correlation IDs. The AI slice will add agent-loop and tool-call correlation without exposing message content.

The `/admin/mail` storage view is Cloud-admin-only and observational. Its mailbox table reports message count, logical message bytes, received-attachment bytes, draft and ordinary outgoing-upload bytes, external-link bytes, logical total, and last calculation time. It supports search and sorting by total without exposing subjects, addresses, filenames, or attachment content.

Mailbox rows report logical referenced bytes, not attributed physical disk usage. Content-addressed blobs can be referenced by more than one mailbox, so assigning their physical bytes to one mailbox would be misleading. A separate global summary reports physical Mail relation and blob storage. A durable aggregate projection is updated from known byte lengths and periodically reconciled; the admin page never scans message or blob tables synchronously. No value in this view blocks upload, sync, or send in the initial release.

### Retention and backup

PostgreSQL stores mailbox settings, permissions, mirrored message content, all attachment bytes, assignments, work state, snooze deadlines, comments, drafts, manual thread overrides, conversation references, workflows with inline response timing, signatures, snippets, activity, commands, and deletion tombstones. The initial policy retains these records indefinitely, including after a provider-side deletion or complete loss of provider access. Future AI artifacts will follow the same retention policy. Mailbox deletion never deletes provider mail or physically purges this dataset. It atomically marks the mailbox deleted, pauses its transport, fences in-flight synchronization and hydration, prevents new provider effects, and disables unfinished workflow execution. A current mailbox admin may restore the retained mailbox into a paused state; diagnostics must pass and synchronization must be enabled explicitly before provider access resumes.

Backups cover the same durable dataset, including chunked attachment blobs. Reindexing or reconnecting a provider must never be the only recovery path for collaboration history or attachment content.

The first release has no app-level mailbox byte quota and never truncates a provider message to satisfy local storage. Operators monitor PostgreSQL capacity and configure deployment-level admission backpressure. If a complete message or attachment batch cannot be committed, synchronization records a storage error, leaves the remote message and mailbox cursor unacknowledged, and retries after capacity is restored; list and collaboration features remain available from already committed data.

## Verification

Verification must prove recovery and authorization, not only happy-path API behavior.

### Protocol matrix

The matrix is cumulative. Only generic IMAP/SMTP behavior gates the first complete release. Named providers are interoperability fixtures, not separate first-release support promises. JMAP, Graph, and Gmail API rows become release gates only when their connector slices ship.

- Dovecot or another controllable generic IMAP/SMTP server.
- Generic IMAP without QRESYNC, CONDSTORE, MOVE, IDLE, or SPECIAL-USE.
- Server with personal, other-user, and shared namespaces plus standard ACLs.
- Generic IMAP fixture modeling a functional address delivered into a shared namespace.
- At least one independent generic IMAP implementation in addition to the controllable fixture.
- Optional interoperability runs for Stalwart, Gmail or Workspace, Microsoft 365, and the University of Ulm service without provider-specific release guarantees.
- Stalwart Group inbox through JMAP.
- Fastmail or another independent JMAP implementation.
- Microsoft 365 shared mailbox through Graph.
- Gmail or Workspace through the Gmail API.

### Onboarding scenarios

- Known-provider preset with OAuth.
- DNS SRV and Thunderbird-style autoconfiguration.
- App password and compact manual host configuration.
- IMAP succeeds while SMTP fails, and the reverse.
- Ambiguous or absent special-use folders require one remembered mapping step.
- Folder selection imports exactly the visible provider folders selected for Cloud synchronization and never infers cross-user folder equivalence.
- Sender identity requires separate provider or verification-send authorization.

### Failure scenarios

- Process crash during every sync batch boundary.
- Sync leader loses its lease during a batch; the atomic PostgreSQL fence check rejects its projection and cursor commit after a replacement leader starts.
- Alice's active sync binding is revoked; Bob continues from the last mailbox-owned committed cursor without duplicate or missing changes.
- An actor mutation or send fails after binding selection and never falls back to another user's binding.
- An ambiguous command remains pinned to its original binding until reconciliation.
- Every binding becomes invalid; PostgreSQL data remains intact while remote work pauses in `connection_required`.
- Disconnect before and after IMAP MOVE completion.
- MOVE fallback on a server without UIDPLUS records `expunge_pending` and never issues mailbox-wide `EXPUNGE` or `CLOSE`.
- Disconnect after SMTP acceptance but before local confirmation.
- An unresolved send outcome reaches `needs_attention` without an automatic duplicate send.
- UIDVALIDITY change and folder rename/delete.
- Concurrent external client flag and move changes.
- Expired credentials and OAuth refresh failure.
- Duplicate `Message-ID` and missing threading headers.
- Duplicate workflow delivery and concurrent inbound messages attempting the same reference allocation or automatic reply.
- Automatic-reply send becomes ambiguous after provider acceptance.
- 100 MiB MIME source with streamed attachment handling.
- PostgreSQL storage admission fails mid-import; no partial message or advanced cursor is committed, and sync resumes after capacity returns.
- Malformed MIME, unusual charset, malicious HTML, and tracking pixels.

### Permission scenarios

- User, group, service-account, and delegated-user access.
- Permission reduction between command request and execution.
- Revocation during search, attachment download, WebSocket reconnect, workflow run, and AI tool call.
- Cross-mailbox OR query attempts.
- Revoking the provider binding stops remote work but does not remove Cloud access to cached mail, attachments, comments, or activity.
- A folder without current provider read rights is excluded from synchronization and remote commands.
- Agent and workflow actions exceeding their allowed action scope.
- Remote shared-folder rights removed while content, a stream, and delayed commands are cached locally.
- Sender identity allowed in Cloud but rejected by the SMTP provider.
- A shared Cloud mailbox remains readable while its provider connection is revoked.
- A mailbox never exceeds its current mailbox-owned binding's rights.
- A mailbox admin can replace or revoke credentials but can never read the stored secret.
- A service account uses the mailbox binding only after both Cloud scope and mailbox permission checks succeed.
- A writer moves messages between existing folders but cannot create, rename, or delete remote folders without `admin`.

### Shared-folder scenarios

- Discover multiple namespace roots with different prefixes and delimiters.
- Discover personal, other-user, and shared namespaces exposed to one account without treating subscription as visibility.
- Represent two principals' server-visible trees as separate Cloud mailboxes without inferred cross-account identity.
- Read-only, flag-only, insert, move, delete, and folder-administration ACL combinations.
- ACL extension absent with conservative capability fallback.
- Shared folder renamed, removed, or revoked after initial synchronization.
- A new visible folder appears without being subscribed and is discovered automatically.
- A folder rename leaves the old provider subscription unchanged; Cloud reconciles the folder identity and repairs subscriptions only through a separate idempotent action.
- `NOTIFY` absent or disconnected still converges through scheduled namespace, `LIST`, subscription, and rights discovery.
- Rejected or overflowed IMAP notification registration falls back to scheduled reconciliation.
- An ACL change makes a folder newly listable or removes list rights; discovery updates the projection without manual mailbox re-onboarding.
- Two authenticated principals expose the same path without unsafe automatic deduplication or linking.
- Revoking the current binding pauses remote work while retaining one remote resource and cursor history.
- Reply selects a configured functional identity only after SMTP verification on the mailbox binding.
- Interactive and autonomous sends never use credentials outside the mailbox; automation remains disabled unless explicitly enabled for the identity.
- Sent copy lands in the configured shared Sent folder without duplication.

### Connector parity scenarios

- The same portable query and command contracts pass against generic IMAP, JMAP, Graph, and Gmail fixtures.
- Connector-specific IDs never escape into mailbox APIs, workflow definitions, or AI tools.
- Capability loss selects the documented fallback or returns one typed unsupported result.
- Replacing an IMAP binding with JMAP for the same mailbox requires no domain-data migration.

### Conversation scenarios

- Provider-native thread IDs group an original message and replies without duplicate placements.
- The opaque conversation ID remains stable and distinct from optional human references used in search and templates.
- `References` and `In-Reply-To` group replies when no provider thread ID exists.
- Missing or malformed headers use the conservative subject, participant, and time fallback without merging unrelated mail.
- Duplicate `Message-ID` values remain separate when other evidence disagrees.
- Manual merge and split survive reindexing and connector replacement and remain audited.
- Merge retains secondary references as searchable aliases; split never assigns the same reference to both conversations.
- A visible reference with matching participants may recover a broken thread; a reference without participant evidence only suggests a possible match.
- Recognized quoted history is collapsed visually while raw message content remains unchanged.
- Selecting lines from a history message inserts an attributed quote at the current reply cursor and produces correct plain-text `>` and HTML quote output.
- Received attachments remain attached to their source message; outgoing uploads remain attached to the active draft and never appear in one ambiguous drawer.
- Reply all excludes active sender and actor addresses, deduplicates recipients, and exposes the final To and Cc lists before sending.
- Forward starts without recipients, uses the selected message rather than the entire conversation, and lets the sender exclude original non-inline attachments.
- New, reply, reply-all, and forward composers use Send, Reply, Reply all, and Forward respectively as their primary action.
- Attachment groups retain a visible origin label in normal reader and composer states.
- The Details badge equals unread internal comments and disappears when no unread comments remain.
- Hiding and restoring the conversation list preserves the selected conversation, reader scroll position, draft, uploads, and permissions.
- New, reply, reply-all, and forward drafts retain their intent on one canonical, revision-safe draft route and cannot send duplicate revisions.
- Draft text survives navigation, reload, browser restart, an interrupted autosave, and an offline interval without creating empty server drafts or duplicate editing sessions.
- Direct and resumable attachment uploads use the same durable upload state machine. Sending is rejected while an upload is incomplete, cancellation is retry-safe, and abandoned upload bytes are removed by bounded background cleanup.
- Readers can inspect mailbox drafts and request review without editing; writers can take over and send. Autosave does not notify the mailbox or flood user-facing activity.
- A stale editor preserves its local text as a recovery copy, while an explicit takeover and the first successful idempotent send make older editors read-only.
- A Cloud draft appears in the provider Drafts mailbox; a provider-created draft is imported; independent Cloud and external edits produce explicit conflict copies rather than silent last-write-wins behavior.
- Replacing an IMAP draft snapshot records the new UID before retiring the prior snapshot. Failure between those operations is reconciled without losing the accepted Cloud revision.
- Remote deletion soft-discards an unchanged projected draft but never deletes a newer Cloud revision. External-client activity is attributed only as precisely as the provider binding permits.
- Two collaborators add comments, replies, edits, and deletion tombstones concurrently without losing revisions.
- Internal comments remain in the Details panel and never appear as a mode in any mail composer.

### Workflow scenarios

Implemented verification covers:

- strict canonical YAML, source diagnostics, catalog binding, recursive conditions, `if`, `switch`, and Mail rejection of `forEach`;
- immutable version creation, expected-version activation/deactivation, metadata outside YAML, and authorization snapshots;
- read-only preflight, hydration requirements, frozen source preconditions, stale preflight rejection, target/effect budgets, keyset materialization, and automatic restart recovery;
- direct, one-shot, backfill, and durable dry-run records with paginated target progress, API/CLI cancellation, permission revocation, and restored step outcomes;
- durable keyword/move commands, transactional assignment/status actions, waiting, dependency wakeup, lease fencing, recovery, and `needs_attention`;
- atomic conversation-reference allocation, merge/split alias semantics, exact reference search, inline response-timing validation and deferral, automatic-reply loop suppression, concurrent deduplication, recipient rate limits, and durable outbox materialization;
- deduplicated live incremental `messageReceived` delivery, historical-import suppression, revoked-actor skips, expired-trigger-claim recovery, and revision-fenced schedule slots.

Remaining product scenarios include a richer workflow-authoring experience beyond canonical YAML, AI decisions, conflict analysis, and generated bulk plans.

### Scale scenarios

- 20,000-message everyday mailbox.
- 100,000-message large mailbox.
- Multi-mailbox deployment with bounded connections and concurrent backfills.
- Search during active body indexing.
- Native FTS and `pg_textsearch` with equivalent match and permission semantics.

### Provisional targets

Targets require a documented reference environment before they become release gates.

- Warm list queries: p95 below 150 ms at 100,000 messages.
- Warm structured search: p95 below 500 ms at 100,000 messages.
- Local UI feedback after a command: below 100 ms.
- Durable collaboration update visible to another active client: below 1 second under normal load.
- No worker buffers an entire large attachment in memory.
- Every backfill and reindex can pause, resume, and recover after process restart.

## Delivery plan

The slices record delivery order while preserving the final architecture.

Slices 1 through 5 and slice 7 form the implemented generic IMAP/SMTP product. Slice 6 adds AI without changing the non-AI product, while slices 8 and 9 improve provider fidelity through the same contracts. Search, collaboration, workflows, and command-first UX are not withheld from generic IMAP users.

### 1. Foundation contracts

Status: Implemented.

- Mail package, schema, mailbox resource adapter, mailbox-owned provider connections, remote resources and sync state, current and historical binding states, encrypted credential fields, sender identities, and capability model.
- Central `resolveMailExecution` contract, command binding and credential-revision pinning, distributed sync lease, and fencing token.
- Provider-neutral remote account, container, message-reference, cursor, command, submission, and error contracts.
- Conversation grouping, durable thread overrides, comments, mailbox reference configuration, inline response timing, and atomic reference allocation.
- Connector conformance harness and protocol fixtures.
- Domain query/command contracts used by API and CLI.

Success: connect a test mailbox, discover its remote account and namespaces, persist a resumable connector cursor, and prove that Cloud permission cannot exceed the current binding's remote rights.

### 2. Complete IMAP onboarding, sync, and search

Status: Implemented for generic IMAP/SMTP. Enhanced connectors remain separate slices.

- Email-first setup with provider presets, OAuth where available, RFC 6186, Thunderbird-style autoconfiguration, and compact manual fallback.
- Parallel IMAP/SMTP verification, remembered folder mapping, shared-subtree selection, and sender-identity verification.
- Staged recent-first sync, body and attachment hydration into PostgreSQL, namespace/folder/subscription discovery, ACL reconciliation, extension fallbacks, and repair.
- Native PostgreSQL search, structured AST, keyset pagination, and saved views.
- Optional `pg_textsearch` capability and health checks.

Success: a generic IMAP account is usable without expert protocol knowledge, and a 100,000-message fixture remains searchable during resumable backfill with no permission leakage.

### 3. Core mail operations

Status: Implemented for generic IMAP/SMTP.

- Folder tree, dense one-line list, threaded conversation view, quote collapsing, selected-text reply quoting, manual merge/split, flags, keywords, move, archive, trash, compose, reply, drafts, multiple verified sender identities, send, Undo Send, and Scheduled Send.
- Safe HTML rendering plus received attachments on their source message and outgoing attachments in their draft composer.
- Provider-aware Sent behavior and ambiguous-outcome reconciliation.

Success: generic IMAP/SMTP delivers the complete portable mail-operation set; all portable actions appear correctly in a second mail client and survive injected crashes.

### 4. Collaboration

Status: Implemented, including permission-scoped Contacts context.

- Assignment, needs-action/waiting/done state, snooze, reminders, chronological comment chat, activity, presence, and shared draft revisions.
- Needs action, Mine, Unassigned, Waiting for reply, Done, Snoozed, and Recently Active views.

Success: two users can triage, comment, draft, and reply without silent conflicts, with complete actor-attributed history and no risk of sending an internal comment externally.

### 5. Deterministic workflows

Status: Implemented for the bounded non-AI action vocabulary and current management UI.

- Canonical shared-kernel YAML, validation/binding, immutable Mail versions, run history, preflight, and deterministic actions.
- Live `messageReceived`, revision-fenced schedules, direct/one-shot/backfill/dry-run execution, effect budgets, durable waiting, and fenced recovery.
- Immutable conversation references and guarded automatic replies with inline response timing through the ordinary durable send path.
- Provider moves/copies/archive/trash, flags and keywords; local tags, assignment, status and comments; draft creation, scheduled draft delivery and internal notifications.
- Pause/resume, cancellation, and targeted retry through lineage-preserving child runs.
- Next: richer visual authoring, AI decisions, conflict analysis, and generated bulk plans.

Current success: a non-AI workflow can route and copy mail, change flags or keywords, update collaboration state, create and schedule drafts, notify users, allocate a reference, and send a guarded automatic reply for a live inbound message with version-pinned preflight, current authorization, bounded idempotent effects, operator controls, recovery, and audit.

### 6. AI decisions and agents

Status: Planned; no Mail AI resource, tools, artifacts, or workflow decision nodes are shipped.

- Structured AI workflow nodes, caching, error branches, and cost preview.
- Mailbox AI resource, tools, approval policies, summaries, labels, and suggested drafts.
- Natural-language bulk-plan generation with immutable approval and optional conversion to a recurring rule.
- CLI/service-account workflows and initial Mail skills.

Success: an agent can search, classify, assign, draft, and execute a bounded mailbox-reorganization plan with current permissions; interactive agent send remains approval-bound and fully audited.

### 7. Product-speed pass

Status: Primary workspace implemented. Final cross-browser accessibility and explicit frontend performance regression gates remain release-hardening work.

- Command registry, configurable shortcuts, focus preservation, prefetch, toggleable conversation list, combined Details panel, and keyboard/pointer parity.
- Performance and accessibility gates.

Success: repeated triage is stable, measurable, and usable without a mouse or memorized shortcuts.

### 8. JMAP enhanced connector

Status: Planned.

- Implement the same connector contract with JMAP Core, Mail, Submission, push, and server-exposed rights.
- Validate Stalwart Group inboxes and one independent JMAP provider.
- Preserve mailbox, collaboration, search, workflow, command, and AI data while switching bindings.

Success: an existing Cloud mailbox can use JMAP without migration and gains state-based sync, stable IDs, push, and native submission where advertised.

### 9. Provider-native connectors

Status: Planned.

- Add Microsoft Graph for shared mailboxes, delegated access, delta sync, and separate Full Access, Send As, and Send on Behalf semantics.
- Add Gmail API for native labels, threads, history sync, sender settings, and administrator-authorized Workspace access.
- Keep OAuth IMAP/SMTP available when it is the user's preferred or only supported path.

Success: provider-native capabilities improve fidelity without changing the feature vocabulary, permission model, or stored collaboration state.

## Alternatives

### Thin IMAP client

A thin client with a transient cache minimizes initial code but makes search, collaboration, agent access, and recovery depend on live IMAP latency. It does not meet the product goals.

### PostgreSQL as mail authority

Making PostgreSQL authoritative for current remote existence, placement, or flags would break compatibility with other clients and create two-way synchronization conflicts. The provider remains authoritative for portable current state; PostgreSQL durably retains imported content and owns Cloud-only collaboration state.

### JMAP-only first

JMAP offers cleaner change tracking, stable IDs, and native submission, but its deployment base is much smaller than IMAP and excludes Google and Microsoft consumer and enterprise mail APIs. JMAP remains an early enhanced connector, while generic IMAP/SMTP ships first as a complete product.

### IMAP-shaped domain model

Persisting UID, `UIDVALIDITY`, namespace paths, and SMTP assumptions directly in domain commands would simplify the first connector but force migrations and leaky APIs for JMAP, Graph, and Gmail. These values remain typed connector metadata behind provider-neutral references.

### Reuse Grids workflows directly

Grids workflows already provide durable execution patterns but their schema and runtime depend on Grids records, documents, permissions, and references. Direct reuse would couple app domains. Mail borrows the patterns and extracts shared code only after a second compatible runtime exists.

### Generic workflow platform now

A generic cross-app workflow platform would require an abstract type system, capability registry, permission algebra, and editor before Mail has one stable workflow. This is premature. The Mail decision tree stays intentionally typed and bounded.

### AI-only automation

An AI-only router makes ordinary filters expensive, nondeterministic, hard to audit, and unavailable during provider outages. Deterministic rules remain the default; AI handles semantic decisions that ordinary conditions cannot express.

### Dedicated ticket or responder subsystems

A separate ticket store would duplicate conversations, assignment, comments, activity, and search. A separate automatic-response engine would duplicate workflow conditions, templates, policies, runs, and audit. Human references and guarded automatic replies therefore remain typed conversation and workflow capabilities rather than separate product modes.

## References

- [IMAP4rev2, RFC 9051](https://www.rfc-editor.org/rfc/rfc9051.html)
- [CONDSTORE and QRESYNC, RFC 7162](https://www.rfc-editor.org/rfc/rfc7162.html)
- [IMAP MOVE, RFC 6851](https://www.rfc-editor.org/rfc/rfc6851.html)
- [IMAP UIDPLUS, RFC 4315](https://www.rfc-editor.org/rfc/rfc4315.html)
- [IMAP SPECIAL-USE, RFC 6154](https://www.rfc-editor.org/rfc/rfc6154.html)
- [IMAP namespace, RFC 2342](https://www.rfc-editor.org/rfc/rfc2342.html)
- [IMAP ACL, RFC 4314](https://www.rfc-editor.org/rfc/rfc4314.html)
- [IMAP LIST command extensions, RFC 5258](https://www.rfc-editor.org/rfc/rfc5258.html)
- [IMAP NOTIFY extension, RFC 5465](https://www.rfc-editor.org/rfc/rfc5465.html)
- [Using SRV records to locate email services, RFC 6186](https://www.rfc-editor.org/rfc/rfc6186.html)
- [SMTP, RFC 5321](https://www.rfc-editor.org/rfc/rfc5321.html)
- [Internet Message Format, RFC 5322](https://www.rfc-editor.org/rfc/rfc5322.html)
- [Recommendations for automatic responses, RFC 3834](https://www.rfc-editor.org/rfc/rfc3834.html)
- [JMAP Core, RFC 8620](https://www.rfc-editor.org/rfc/rfc8620.html)
- [JMAP Mail, RFC 8621](https://www.rfc-editor.org/rfc/rfc8621.html)
- [JMAP Sharing, RFC 9670](https://www.rfc-editor.org/rfc/rfc9670.html)
- [JMAP Mail Sharing draft](https://datatracker.ietf.org/doc/draft-ietf-jmap-mail-sharing/)
- [ImapFlow documentation](https://imapflow.com/docs/)
- [Nodemailer documentation](https://nodemailer.com/)
- [MailParser documentation](https://nodemailer.com/extras/mailparser)
- [Thunderbird automatic account configuration](https://wiki.mozilla.org/Thunderbird:Autoconfiguration)
- [Stalwart email protocol overview](https://stalw.art/docs/email/)
- [Stalwart Group principals](https://stalw.art/docs/auth/principals/group/)
- [Stalwart mailing lists](https://stalw.art/docs/email/management/mailing-lists/)
- [Microsoft shared-mailbox permissions](https://learn.microsoft.com/en-us/exchange/collaboration/shared-mailboxes/create-shared-mailboxes)
- [Microsoft Graph shared sending](https://learn.microsoft.com/en-us/graph/outlook-send-mail-from-other-user)
- [Gmail delegation](https://support.google.com/mail/answer/138350)
- [Google Groups Collaborative Inbox](https://support.google.com/a/users/answer/10375787)
- [Gmail API overview](https://developers.google.com/workspace/gmail/api/guides)
- [pg_textsearch](https://github.com/timescale/pg_textsearch)
- [Superhuman Split Inbox](https://help.superhuman.com/hc/en-us/articles/46005619081101-Default-Split-Inbox)
- [Superhuman shared conversations](https://help.superhuman.com/hc/en-us/articles/46005593675917-Shared-Conversations-and-Team-Comments)
- [Superhuman MCP server](https://help.superhuman.com/hc/en-us/articles/46005696690317-Superhuman-Mail-MCP-Server)
- [Thunderbird identities](https://support.mozilla.org/en-US/kb/using-identities)
- [University of Ulm email service and Shared Folders](https://www.uni-ulm.de/einrichtungen/kiz/service-katalog/e-mail-kalender-zusammenarbeit/e-mail/)
- [Cloud AI resource helper](../packages/cloud/src/ai/resource.ts)
- [Cloud AI tool and approval helper](../packages/cloud/src/ai/tools.ts)
- [Shared Cloud workflow language](../packages/cloud/src/workflows/language/index.ts)
