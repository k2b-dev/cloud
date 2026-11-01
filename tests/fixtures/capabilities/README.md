# Frozen Capability manifests

`v2` is the reviewed baseline for the coordinated protocol 2 hard cut. It includes
interactive Commands and scoped search inputs. Protocol 1 providers cannot join
this release; this baseline does not promise protocol 1 compatibility.

The provider conformance test compiles current declarations and checks their
evolution against these files. Do not regenerate them to hide a regression.
Review incompatible changes as a new coordinated contract before updating a
baseline. The explicit required-idempotency inventory remains independently
asserted in the test.

The Grids baseline includes the separately reviewed, intentional application hard
cut: compact GQL context and results, typed list columns, offset-aware timestamps,
reviewed idempotent record creation, and table-scoped approval for updates and
external upserts. See the [Grids upgrade notes](../../../docs-site/apps-content/en/grids.md#coordinated-capability-upgrade)
for caller changes. Its database-backed provider tests validate permissions,
query results, conflict protection, and durable issuance replay. The independent
required-idempotency inventory and normal evolution check remain active for
future changes; this is not a blanket exemption for Grids.

The coordinated Code container migration intentionally moves Grids GQL, View
creation and workflow actions to a `grids.base` target, and record writes and
document issuance to a `grids.table` target. The Grids baseline includes this
reviewed input/target change; normal evolution checks and the required-idempotency
inventory remain active. Files is covered by its owning capability tests, not
this provider inventory. See the
[Grids and Files target migration](../../../docs-site/docs/en/operations/grids-files-capability-targets.md)
for caller changes.

The Mail send migration intentionally requires `expectedContentHash` on
`draft.send` and returns `contentHash` from `draft.send.review`. These two schema
entries and their hashes are updated for the approved breaking contract; other
Mail evolution checks remain active. See the [Mail migration](../../../docs-site/docs/en/reference/deprecations-and-migrations.md#mail-send-requires-a-content-fingerprint).

The coordinated Code target migration intentionally moves Mail's mailbox-scoped
operations from `input.mailboxId` to a `mail.mailbox` target. Only those input
fields, target declarations, and their hashes change in the Mail baseline;
existing result and safety contracts remain checked. Readers, cross-mailbox
queries, and `draft.send.check` keep their inputs. See the
[Mail target migration](../../../docs-site/docs/en/reference/deprecations-and-migrations.md#mail-capabilities-name-their-mailbox).

The Weather geo migration removes only `city.search` from its baseline. Call
Core `address.autocomplete` with `type: "city"` and pass the selected coordinates
to Weather. The remaining evolution checks stay active. See the
[Weather migration](../../../docs-site/docs/en/reference/deprecations-and-migrations.md#weather-city-search-uses-core-geo).

The coordinated Code target migration intentionally moves Spaces and Contacts
resource Actions to fixed `space` and `book` targets. Creation inputs omit
`spaceId` or `bookId`; `contact.move` supplies its destination through
`refs.targetBookId`. The three Spaces calendar Actions with Mail draft effects
also declare `code: false`. Only these input fields, target/ref declarations,
Code availability, and their hashes change in these baselines; result contracts,
query inputs, idempotency inventory, and future evolution checks remain active.
See the [Spaces and Contacts migration](../../../docs-site/docs/en/reference/deprecations-and-migrations.md#spaces-and-contacts-actions-name-their-container).

The combined Spaces target and default-column contract makes `task.create`
`columnId` optional while keeping its fixed `space` target and omitting
`input.spaceId`. Only that column schema, its description, and the corresponding
hashes change in the Spaces baseline. Omitted columns select the first open
column in numeric rank and public-ID order; other evolution checks remain active.

The coordinated Code target migration moves Notebooks, Pulse, Venue, and
Weather Actions from resource IDs in input to their declared resource target.
These baselines update only the existing Actions' target declarations, removed
container-ID fields, and corresponding hashes; result schemas and safety
contracts remain frozen. Unrelated additive changes stay out of the baseline
and are still checked as additive evolution. See the application target guides for
[Notebooks](../../../docs-site/apps-content/en/notebooks.md#capability-action-targets),
[Pulse](../../../docs-site/apps-content/en/pulse.md#capability-action-targets),
[Venue](../../../docs-site/apps-content/en/venue.md#capability-action-targets), and
[Weather](../../../docs-site/apps-content/en/weather.md#capability-action-targets).
