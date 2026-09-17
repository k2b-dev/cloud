# Frozen Capability manifests

`v2` is the reviewed baseline for the coordinated protocol 2 hard cut. It includes
interactive Commands and scoped search inputs. Protocol 1 providers cannot join
this release; this baseline does not promise protocol 1 compatibility.

The provider conformance test compiles current declarations and checks their
evolution against these files. Do not regenerate them to hide a regression.
Review incompatible changes as a new coordinated contract before updating a
baseline. The explicit required-idempotency inventory remains independently
asserted in the test.

Grids remains under active development. Its previous baseline is carried forward
with only the protocol version and empty Commands collection updated. New Grids
operations and compatibility changes still require a separate review; they are
not accepted by regenerating this fixture.
