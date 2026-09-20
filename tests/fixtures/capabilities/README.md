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
