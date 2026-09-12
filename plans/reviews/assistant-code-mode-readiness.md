# Code Mode readiness review

Date: 2026-09-12. Scope: the PDF/XLSX and large-folder hardening slice following
`assistant-code-mode-review.md`. No production deployment or Git commit performed.

## Conclusion

The platform mechanics now support local document processing, long cooperative
jobs, explicit app test fixtures, and imports into the existing remote database.
They have been exercised in the real isolated browser worker and CLI, as well as
against disposable Postgres and rsql. This is not certification of Sparkasse,
DHL, or FedEx document parsers: representative originals were not supplied.

## Review disposition

| Finding | Disposition and evidence |
| --- | --- |
| F1: no local PDF API | Fixed. Bundled PDF.js 6.3.289 exposes `pdf.open/readPage/close`; text and positions extracted under the existing opaque-worker CSP. No network fallback. |
| F2: 15-second interaction limit | Fixed for long work through explicit `work.run`, progress, checkpoints, cancellation, and responsive-worker heartbeats. Ordinary callbacks retain a 15-second watchdog. A 17-second job completes and a second job cancels through an available control. |
| F3: picker 64 files / 16 MiB | Fixed for user-local selection. Tested 3,000 references totaling about 24 MiB with preserved subfolder paths. Chat inputs and captured exports have separate bounded quotas and lazy reads. |
| F4: app fixtures rejected | Fixed. Explicit test `inputPaths` populate the picker only. App `files.list/read` cannot access chat files. CLI-host regression verifies lazy fetch and rejects unselected input. |
| F5: capability result mismatch | Disproved. The host unwraps `CapabilityClientResult`; the domain `CapabilityResult` still contains `data`, refs, and files. Existing documented `result.data` is correct; regression added. |
| F6: source history grows forever | Fixed under the existing source quota. Prune only old unpublished, non-current revisions in the write transaction. Publications/current source remain protected; protected history alone can still exhaust the budget. |
| F7: false interruption from another tab | Fixed. Owner renews a server lease while executing or awaiting approval. Other clients cannot execute the call. Expired claims and late completions cannot restart effects. Tested ownership/expiry in Postgres and a 46-second CLI approval. |
| F8: full-tree UI updates | Mitigated with 100-ms coalescing and bounded UI/table sizes. The protocol still sends full trees; no speculative delta protocol added. Bulk apps must update compact progress and paginate results. Large production table throughput remains unbenchmarked. |
| F9: logs stop at 200 | Fixed. Latest-200 ring retains late errors; rate-limited normal logs report suppression. Browser test emits 250 messages followed by an error. |
| F10: confusing API/CLI names | Clarified in progressive skill and CLI reference. Documents/background work load separately from GUI APIs; source-file saves, metadata updates, SQL SELECT, and CLI bundle updates are distinguished. Overload now has its own error code. |
| F11: base64 consumes file quota | Fixed. Transport permits encoding/JSON overhead; decoded shared-storage quota remains authoritative. Contract test covers a full 16-MiB binary payload. |

Additional correction found during integration: an empty rsql SELECT can return
`data: null`; the Assistant database boundary now normalizes that to `data: []`.
The missing public server export for the already-existing invocation middleware
was also restored. No alternate authorization mechanism was introduced. A second real agent run
revealed that HTTP error codes were lost at the worker boundary. Errors now
preserve `error.code`; a focused real CLI-host test verifies `DB_NOT_CONFIGURED`.

## APIs and limits

- `pdf.open(file)`: page count, one-based page text/positions, explicit close.
- `sheet.openExcel(file, {numbers: "string"})`: parse once, sheet names and rows,
  explicit close. Default numeric cells are numbers; decimal strings are useful
  before exact cent conversion. XLSX only; cached formulas, no calculation/writer.
- `work.run(callback)`: one active job; context exposes signal, progress, and
  checkpoint. GUI callbacks launch without awaiting `done`; scripts may await it.
- `code_inspect({runId, waitMs: 30000})`: bounded wait for job state. CLI keeps its
  host alive while work continues, including after explicit interaction steps.
- `files.path(file)` preserves relative paths explicitly across worker messages.
  Local file bytes are read on demand. This is not a guarantee of zero-copy I/O.
- Local folder selection has no aggregate 64-file/16-MiB rejection. Each PDF/XLSX
  parser input is limited to 64 MiB; declared expanded XLSX entries to 128 MiB.
- Selected chat inputs/captured exports: 64 paths, 50 MiB per file, 250 MiB total,
  aligned with existing chat byte defaults. Large exports should use Blob,
  because the separate JSON RPC budget remains 16 MiB.
- Shared persistent storage remains 16 MiB / 1,000 entries per resource; local
  storage follows browser quota with bounded items/metadata. Listings paginate.
- Source budget remains 250 MiB, with protected publications. Copying source to
  an independent resource is a deliberate recovery option, not a data migration.

## Security and failure behavior

Bundled libraries execute inside the terminable worker. No arbitrary package
imports, credentials, shell, eval permission, or network access were introduced.
The XLSX ZIP directory is checked before expansion; corrupt/non-ZIP input and
oversized declared expansion are rejected. These checks are working-set guards,
not a hard browser memory sandbox or proof against every hostile compressed file.
PDF decompression can consume memory beyond its input size. Process one document
at a time, close handles, and retain only required records. A stuck worker can be
terminated; the browser may still run out of memory on pathological input.

Cancellation is cooperative at checkpoints. It does not roll back completed
remote writes or Cloud actions and may wait for an in-flight RPC. Stop terminates
the worker and aborts pending host requests; uncertain effects require inspection.
Closing/reloading the host or OS suspension can interrupt a job. There is no
transparent resume/replay promise. Background execution was verified in Chromium,
not across every Safari/Firefox version or mobile suspension policy.

Direct server tools were inspected through default-tool registration, signed
invocation transport, request middleware, resource handlers, and permission-aware
services. The target/operation/signature and current authority are checked; the
conversation must belong to the acting user and permit the tool. Write call IDs
use the existing replay claims; unknown outcomes are not automatically replayed.
An unavailable Assistant fails explicitly. Source reads paginate rather than
returning entire bundles through the bounded tool reply. Code tools remain direct
Assistant tools; script capability calls retain normal approval checks.

## Verification evidence

Environment: local macOS arm64, Bun 1.3.14, Playwright Chromium, development stack;
synthetic documents, disposable Postgres 17 and rsql 1.0.0. These are correctness
checks, not a throughput benchmark or a promise for all accounting folders.

- Isolated service harness: 23 tests, 182 assertions, including permissions,
  Project/chat/fork/publication isolation, approvals, claim leases, retention,
  lazy database creation and a real 2,500-row import/retry/SELECT join.
- Focused contracts/work/compiler/examples/skill/invocation checks: 24 tests,
  464 assertions. Assistant and Cloud raw typechecks pass.
- Real opaque-worker browser scenario: PDF/XLSX, 3,000 local references, late
  errors, long job/cancel, 1,005 OPFS entries paged 500/500/5, UI and isolation.
  The final browser scenario passed 52 assertions. Negative document checks cover closed handles, corrupt PDF/non-ZIP,
  and oversized expanded XLSX metadata. No server upload is used by that harness.
- CLI-host tests: delayed 46-second approval, denial, closing in-flight work;
  separate lazy-input/app-picker fixture test verifies the authorization seam.
- A further live CLI worker run sequentially opened and closed 1,000 XLSX
  File objects from the small synthetic workbook fixture, reading 2,000 data
  rows without errors. This exercises the batch lifecycle, not diverse real
  workbook complexity or a memory/throughput guarantee.
- Real CLI run completed a 17-second PDF/XLSX job and exported CSV to its test
  chat. A real Assistant agent read both fixtures and produced the expected CSV.
  It initially called `present` before loading it; the skill now explains this.
  A second real agent created one private test script, read XLSX, and correctly
  reported the unconfigured database without changing instance settings. Its
  initial error-code handling exposed the transport issue fixed above.
- Dependencies check and production Assistant image/runtime build pass.
  Grids required a rebuild for an unrelated existing dependency after restarting
  shared-library consumers; it is healthy again. Foreign Grids changes preserved.

## Reference workflows and remaining acceptance

`packages/assistant/examples/accounting` contains application-level reconciliation
and restart-safe batched import helpers, with tests and integration instructions.
The matching example retains file/page evidence, handles credit signs and exact
cent sums, rejects ambiguous references, detects duplicates, treats amount-only
matches as review, and exports aggregate bank amounts once. The import example
uses stable unique keys, atomic 200-row batches, explicit conflicts for changed
rows, and deliberate retry after partial completion. No local SQLite was added.

Open acceptance condition: validate actual format parsers against anonymized
Sparkasse statements, DHL/FedEx invoices/credits, payment advice and multi-page
examples. Synthetic PDF extraction and normalized-record tests prove mechanics,
not those business formats. PDF font/CMap-dependent documents also need sample
validation; the sandbox never fetches missing assets. No OCR/DATEV support.

The development instance has no rsql endpoint configured. Its existing settings
were left untouched. Successful remote import was proven against the isolated
real server rather than redirecting an operator-owned resource database.

## Rollout and rollback

1. Back up application data through the operator's normal procedure. Deploy
   matching Assistant/Core/Cloud code and rebuild Assistant for the pinned parser
   dependencies and worker asset. Finish active jobs before rollout; reload old
   browser hosts before new runs to avoid mixed protocol versions.
2. Migration adds `heartbeat_at NOT NULL DEFAULT now()` idempotently. Existing
   pending calls receive the migration timestamp and expire after the lease
   window unless their original owner renews; they are never replayed. There is no bulk deletion of source history;
   pruning occurs only during subsequent quota-pressured saves.
3. Built-in skill template version is 17. Normal template synchronization updates
   unmodified installed skills; live CLI inspection confirmed template version 17
   with status `current` in the development instance. Preserve customized copies and review their
   available update through the existing skill administration flow.
4. A rollback requires matching prior server and browser assets. The additive lease
   column can remain. Removed unpublished history cannot be reconstructed by a
   binary rollback; publications/current source and resource data stay intact.
   Source using the new APIs requires the new runtime, so inspect affected apps
   before rollback. No production deployment was performed in this task.
