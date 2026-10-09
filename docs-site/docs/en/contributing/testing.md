---
title: Testing
navTitle: Testing
section: Contributing
order: 1304
description: Run unit, render, and integration tests locally, and understand what the pull request gate and nightly run check.
tags: [contributing, testing, ci]
updated: 2026-10-07
---

# Testing

Cloud has two kinds of tests. Unit, render, and behavior tests run anywhere.
Integration tests need real infrastructure and run only when you point them at
it explicitly.

## Run the fast checks

```bash
bun run check
bun run test
```

`bun run check` verifies dependencies, import boundaries, package cycles,
service API contracts, localization, capability presentation, CSS
architecture, formatting, the application set, the CI gate's job list, and
every package typecheck. A package typecheck covers its
`scripts/` as well as `src/`, so a package's build, smoke, and verification
scripts break the gate when they drift from the code they drive. The only
exceptions are scripts a package excludes by name in its `tsconfig.json` and
lists in its scripts README, currently three manual Grids tools. The root
`scripts/` directory is not typechecked. `bun run test` runs every workspace in
its own process and reports the integration files it skipped.

The localization check also rejects hard-coded prose in frontends whose text
comes only from message catalogs, currently Mail: JSX text and expressions,
labels, titles, descriptions, placeholders, and toast or prompt messages with
two or more words. It reads every branch of a conditional, and in a template
literal a substitution next to a word counts as a second word. Single words
such as product names or protocol labels stay allowed.

The capability presentation check compiles the capability declaration each
built-in application passes to `app.start()` and requires a German title and
description for every Type, Query, Action, Command, and Universal Search tag.
The Assistant, approvals, search, and the capability catalog show these
texts to German readers.

For one package:

```bash
bun run --cwd packages/grids typecheck
bun run test --filter packages/grids
```

## Write behavior tests

A behavior test renders Solid components into a
[happy-dom](https://github.com/capricorn86/happy-dom) document and drives them
like a user. Name it `*.behavior.test.ts` or `*.behavior.test.tsx` and put it
anywhere in a workspace package. `bun run test` finds every such file and runs
each package's behavior tests in a suite of their own, `<package> behavior`,
with browser conditions and the Solid DOM preload
(`packages/ui/test/solid-dom-preload.ts`), started from the repository root so
a package's server-rendering preload does not apply. Package `test` scripts
leave these files out with `--path-ignore-patterns '**/*.behavior.test.*'`.

To run one file directly:

```bash
bun --no-env-file test --isolate --conditions=browser \
  --preload ./packages/ui/test/solid-dom-preload.ts \
  ./packages/core/src/pages/admin/CacheNotice.behavior.test.ts
```

Guard browser-only tests with `isServer` from `solid-js/web`, so a plain
`bun test` skips them instead of failing. `bun run check` fails when a test
that branches on `isServer` is not named `*.behavior.test.*`, or when the
runner would not pick up a behavior test.

Load heavy components once at module scope, not inside the first test: the
first import runs the Solid transform over the component's source graph, and
that time otherwise counts against the 5 s test timeout. A plain module-scope
import does not work, because the `@k2b/ui` browser build needs a document
while its modules evaluate. Load the component under a temporary harness from
`packages/ui/test/dom.ts`, after any top-level `mock.module` calls:

```tsx
const load = async () => {
  const dom = createDomTestHarness();
  try {
    return (await import("./RecordsView")).default;
  } finally {
    dom.cleanup();
  }
};
const RecordsView = isServer ? undefined : await load();
```

Solid attaches its delegated event listeners, such as the one for `click`, to
the document that exists while a module evaluates, here the temporary one. A
test that clicks therefore calls `delegateEvents(["click"], dom.document)` for
its own document.
`packages/grids/src/frontend/_components/records-view/RecordsView.behavior.test.tsx`
loads its component after module mocks and registers delegated events in each
test.

## Test in Chromium and WebKit

Layout, focus, touch, and paint need a real engine, so these tests drive one
through Playwright. They are named `*.browser.test.ts`, except a few behavior
tests that start a browser. Each one starts its browser with `launchBrowser()`
from `packages/ui/test/browser.ts`:

```ts
import { browserName, launchBrowser } from "../../test/browser";

const browser = await launchBrowser();
```

`TEST_BROWSER` chooses the engine: `chromium`, the default, or `webkit`, the
engine of Safari and of every browser on iOS. `bun run check` fails when a test
starts a Playwright browser type directly, or when a Playwright test does not
import the launcher directly as `.../test/browser`, without a file extension:
`bun run test --browser` finds the tests by that import. The Assistant artifact
suites are the only exception: they run nightly in Google Chrome, except the
HTML app frame, runner and chat card suites, which use the launcher.

`bun run test --browser` runs only these tests, each file in a process of its
own, and fails when it finds none. Files that also need `CLOUD_TEST_*`
targets, such as the OAuth consent test, run with `--integration` instead.
`--filter` narrows the run to a package or a file name.

### Run WebKit locally

Playwright's WebKit needs system libraries that most Linux machines do not
have. The Playwright image brings them, and `playwright run-server` serves its
browsers to tests outside the container. `TEST_BROWSER_ENDPOINT` makes
`launchBrowser()` connect to that server instead of starting a browser. The
server must have the `playwright` version of the root `package.json` catalog.
The tests read `@k2b/ui` from `packages/ui/dist`, which `--browser` does not
rebuild, so build it first:

```bash
bun run --cwd packages/ui build
version=$(bun -p 'require("./package.json").workspaces.catalog.playwright')
docker run --detach --name playwright-webkit --network host --init --ipc=host \
  --user pwuser --workdir /home/pwuser "mcr.microsoft.com/playwright:v$version-noble" \
  npx -y "playwright@$version" run-server --port 3333 --host 127.0.0.1

TEST_BROWSER=webkit TEST_BROWSER_ENDPOINT=ws://127.0.0.1:3333/ \
  bun run test --browser --filter packages/ui

docker rm --force playwright-webkit
```

Host networking lets the browser reach the servers that tests start on
`127.0.0.1`. On a Mac, Playwright's WebKit runs without the image: install it
with `./packages/ui/node_modules/.bin/playwright install webkit` and leave
`TEST_BROWSER_ENDPOINT` unset.

### Engine differences

Write each test so that it checks the same behavior in both engines. Where
they legitimately differ, branch on `browserName` and say why next to the
branch:

- Playwright drives WebKit's touch input only as a whole tap. A test that holds
  or moves a finger, or that changes the default font size, needs Chromium's
  DevTools protocol. Such a test is skipped in WebKit with
  `test.skipIf(browserName === "webkit")` and a comment that names the reason.
- WebKit matches `forced-colors: active` under emulation but has no forced
  colours mode that repaints author colours.
- WebKit does not support `reading-flow` yet, so focus and VoiceOver keep the
  source order where a grid or flex layout shows elements in another order.
  Put elements in the source in the order they are shown, in every layout,
  so that a focus order test expects the same order in both engines.
- Playwright's WebKit draws overlay scrollbars that reserve no gutter.
- Playwright's WebKit ignores the charset of a routed response. A page that a
  test serves names it with `<meta charset="utf-8">`, as every Cloud page
  does.
- Chromium's phone emulation widens `window.innerWidth` to content that is
  wider than the screen. Measure sideways overflow against
  `document.documentElement.clientWidth`.
- Playwright can read and type into a page before its first frame, and WebKit
  can hold that frame back while a page loads. A dialog places its initial
  focus in the next frame after it opens; until then, keys go to the element
  the browser focused first. A test that types into a dialog right after it
  opens first waits for the dialog's content and then for one frame:
  `await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))`.
- Neither engine shows a PDF in a frame. Chromium's headless shell reports
  `navigator.pdfViewerEnabled === false`, so `PdfPreview` shows its
  missing-viewer hint instead of the frame, and an automatic preview requests
  nothing; Playwright's WebKit reports a viewer but never loads the document,
  so the loading state stays over the frame. A test therefore defines
  `pdfViewerEnabled` on `Navigator.prototype` in an init script: `true` where
  it measures the frame, `false` where it checks the hint. Where it needs the
  loaded document, it dispatches the frame's `load` event itself.
- Fonts differ between machines and engines. A test that expects text to wrap
  or fit uses text that is clearly too long or clearly short enough.
- Playwright's WebKit on Linux can stop a video for good after a seek when the
  machine is heavily loaded, also after the seek that a media fragment such as
  `#t=1` starts with: `waiting` follows, and the time no longer advances. A
  test that checks that a video plays waits for its `playing` event or for the
  promise of `play()`. It waits for `ended` only when playing to the end is
  what it checks.

## Replace modules in tests

`mock.module` replaces a module for the whole Bun process. Without
`--isolate`, `bun test` runs all files of a suite in one process in
file-system order, so a module mock leaks into every file loaded after it and
the result depends on the machine. A test file that calls `mock.module` at the
top level therefore needs a package `test` script with `--isolate`, or it runs
the mocked part in a child process, as
`packages/notebooks/src/ws-lifecycle.test.ts` does. Prefer the child process
when `--isolate` would make the package suite much slower. `bun run check`
fails on a top-level `mock.module` in a suite that shares one process.

## Run integration tests

Integration tests gate themselves on `CLOUD_TEST_*` variables through
`scripts/fixtures/test-infra.ts`, which is loaded as a `bun test` preload:

| Variable | Example |
| --- | --- |
| `CLOUD_TEST_DATABASE_URL` | `postgres://postgres:postgres@127.0.0.1:5432/cloud_test` |
| `CLOUD_TEST_NATS_SERVERS` | `nats://127.0.0.1:4222` |
| `CLOUD_TEST_NATS_CREDS_FILE` | `/path/to/cloud/.local/nats/test.creds` (absolute path) |
| `CLOUD_TEST_VALKEY_URL` | `redis://127.0.0.1:6380` (no database index) |
| `CLOUD_TEST_FILEGATE_URL` | `http://127.0.0.1:4000` |
| `CLOUD_TEST_GOTENBERG_URL` | `http://127.0.0.1:3001` |
| `CLOUD_TEST_RSQL_URL` | `http://127.0.0.1:8080` |

The ports are the development stack's defaults. If you moved them with
`CLOUD_DEV_POSTGRES_PORT`, `CLOUD_DEV_TEST_VALKEY_PORT`, or `CLOUD_DEV_NATS_PORT`
([Change host ports](/en/docs/operations/monorepo-development#change-host-ports)),
use the same ports here.

A suite runs when its variables are present and fails loudly when the target
is unreachable. When a variable is absent, the suite is skipped and the
matching runtime variables (`NATS_SERVERS`, `GOTENBERG_URL`, and so on) are
removed, because unset is the off switch for those clients. `DATABASE_URL` and
`REDIS_URL` instead point at a closed loopback port
(`postgres://127.0.0.1:1/unset`, `redis://127.0.0.1:1`): Bun's default `sql`
and `redis` handles would otherwise dial `localhost`, so an ungated test that
reaches for them fails with a connection error instead of touching the stack
configured in `.env`.

Run integration tests through `bun run test`: it exports those runtime
variables into every test process before Bun starts, which is the only moment
Bun's default `redis` handle reads `REDIS_URL`. A direct `bun test` applies
them from the preload, too late for that handle; export `REDIS_URL` yourself
before running it. `tests/integration/test-infra-redis-binding.integration.test.ts`
proves the binding against a disposable Valkey on a non-default port.

`bun run test` keeps the checkout's `.env` away from tests. The file
configures the development stack, for example `APP_URL` for a stack served
under another address, and its values would replace the defaults the tests
expect: the OAuth issuer would become the stack's public address. The runner
therefore starts itself with `--no-env-file` and hands the flag to every test
process through `BUN_OPTIONS`, which a Bun process started by a test inherits
with the rest of the environment. Tests see the same configuration as in CI
and in worktrees, which have no `.env`; variables you export in the shell
still reach them.

Package scripts receive the fixture preload through the same `BUN_OPTIONS`,
so a Bun process that such a test starts maps the `CLOUD_TEST_*` targets
again. Give that process another database through `CLOUD_TEST_DATABASE_URL`,
not only `DATABASE_URL`. A `DATABASE_URL` that names the test database with
its own `application_name` stays unchanged, so a test can find the sessions
of the process it started. To run a production script with exactly the
variables an operator would set, pass that environment without
`...process.env` and start the script with `--no-env-file`.

A direct `bun test` loads the dotenv files of its working directory. With a
`CLOUD_TEST_*` variable set, the fixture refuses such a process when a file
like `.env` exists there. Start a direct run from that directory with
`BUN_OPTIONS=--no-env-file bun test …`: unlike `bun --no-env-file test`, the
variable also reaches the Bun processes that tests and package scripts start.

The database name must end in `_test`. Integration tests create and delete
rows; the fixture refuses any other name. Never point them at the development
database.

Every suite shares the test database, and it keeps what earlier runs left
behind. A test that asserts on a database-wide listing with a limit, such as
the oldest candidates of a background job, runs in a private database from
`useFreshDatabase()` in `scripts/fixtures/test-infra`.

The same rule holds for NATS. The development broker keeps the application
streams in the `DEV` account, which accepts connections without credentials,
and bounds tests in the `TEST` account
([Configure local NATS accounts](/en/docs/operations/monorepo-development#configure-local-nats-accounts)).
`CLOUD_TEST_NATS_CREDS_FILE` names the `.creds` file of the test identity,
`.local/nats/test.creds` in the checkout that runs the stack, also when the
tests run from a worktree. It becomes the runtime `NATS_CREDS_FILE`; tests
never use one from the environment or `.env`.
Tests that open their own connection use `connectTestNats()` from
`scripts/fixtures/test-infra`; `bun run check` fails when test code connects
without credentials. Both `connectTestNats()` and the fixture's NATS check
refuse a connection that lands in `DEV`. A broker without accounts, like the
one in CI, needs no credentials file.

Valkey separates tests from the stack by instance. Cache keys such as
`settings:<key>` carry no namespace, so a shared Valkey would hand the running
stack's cached settings to the tests and the tests' values to the stack. The development
stack therefore runs a second Valkey only for tests on port `6380`; the one on
`6379` belongs to the applications. A database index is no way out, because
the fixture refuses one. In CI, the gate's Valkey serves only the tests, so it
stays on `6379`.

```bash
CLOUD_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/cloud_test \
CLOUD_TEST_NATS_SERVERS=nats://127.0.0.1:4222 \
CLOUD_TEST_NATS_CREDS_FILE=/path/to/cloud/.local/nats/test.creds \
CLOUD_TEST_VALKEY_URL=redis://127.0.0.1:6380 \
bun run test --integration
```

`--integration` first prepares the test database by running Core setup and every application migration (idempotent, a few seconds), then runs only the integration files, one fresh global per file. `--shard <n>/<total>` splits
the suites across parallel jobs, which is how the gate runs them; `--exclude <name>`
leaves out suites whose name or path matches, and `--filter <name>` keeps only those.

Suites that exercise sessions, tokens, or access against a real Core identity
authority additionally import `scripts/fixtures/authorization-preload` right
after the gate; it starts the authority only when database and NATS targets are
configured. Bun runs file-level `afterAll` hooks in the order they were
registered, so the preload's teardown, which stops the authority and the process
Sync, runs before the file's own file-level `afterAll`. Put teardown that still
needs either, such as stopping a live outbox, in an `afterAll` inside the
suite's `describe`; Bun runs it when the suite ends.

A new integration test needs no configuration of its own: import nothing
special, use the resolved runtime variables, and name the file
`*.integration.test.ts`.

Keep a test that needs one of these targets out of the Playwright suites
(`*.browser.test.ts`): the nightly browser job sets no `CLOUD_TEST_*`
variables, so the test would only ever be skipped there.

When a package has a `test:integration` script, `bun run test --integration`
runs that script instead of the package's integration files, so the script
must run every one of them. Assistant's runner, for example, gives its
artifact service suite disposable PostgreSQL and rsql containers and runs
every other Assistant integration file, such as the Code Mode PDF test against
Gotenberg, against the `CLOUD_TEST_*` targets.

### Sync namespaces on the test broker

Integration tests share one NATS JetStream account, locally the `TEST`
account of the development broker, and @k2b/sync keeps them apart only by
namespace. JetStream reserves the full size of every stream against the
account, 1 GiB per topic, job, and dead-letter stream by default, so each
namespace a test leaves behind blocks 1.5 to 2 GiB of the account's limit. The
fixture therefore cleans up after every test process:

- Each test process gets its own namespace, `test-<8 hex digits>`, as
  `SYNC_NAMESPACE`. It replaces any value from the environment or `.env`.
- A test that creates its own Sync instance takes its namespace from
  `testSyncNamespace("<label>")`, exported by `scripts/fixtures/test-infra`.
  The name is derived from the process namespace, so the test needs no
  cleanup code of its own. `bun run check` fails when test code passes
  `createSync` any other namespace.
- When the process's tests are done, passed or failed, the fixture deletes
  the streams of the process namespace and of every namespace derived from it.
- A killed or timed-out process never reaches that cleanup. `bun run test`
  therefore first deletes every test namespace whose streams were all created
  more than an hour ago, longer than any test process runs.

The cleanup waits for all test files of a process only when Bun loads the
fixture as a preload: under `bun run test`, and under a direct `bun test`
started from the repository root or from a package whose `bunfig.toml`
preloads the fixture, like Grids. A direct `bun test` from another package
directory loads the fixture inside its first test file. The cleanup then runs
before that file's own `afterAll` hooks and misses every later file, so what
those files leave waits for the sweep of a later `bun run test`.

The cleanup selects streams only by their `sync.namespace` metadata and never
touches a namespace that does not start with `test-`, such as `dev`. Do not
give an installation that uses the test broker a `test-` namespace.

A preload that keeps a Sync instance running until its own `afterAll`, like
Mail's, uses a separate `test-` namespace and deletes it after draining: the
fixture's cleanup runs first, while that instance is still live.

### Caller addresses and rate limits

Per-IP rate limits count in the shared test Valkey, across every test file,
test process, and concurrent run. A fixed address or a small pool lets
unrelated tests spend each other's budget, so a route that allows one request
per minute answers 429 at random. `rateLimit()` counts a request by user only
when it carries a Cloud session. Every other request, whether anonymous or
authenticated with an API key, an OAuth access token, or a test's stand-in
bearer token, counts by address. Without `x-forwarded-for`, that is the address
`unknown`, which every such request shares.

Give each caller its own address, for example from `uniqueCallerAddress()` in
`scripts/fixtures/caller-address`, a fresh address in the IPv6 documentation
range `2001:db8::/32`. Reuse one address only when the test exercises the
limit itself.

## Request cache checks

The request-cache suites modify global settings and cache keys, so they run
through their own runner with disposable containers. See
[Verify request caches](/en/docs/contributing/request-cache-tests).

## What CI runs

The pull request `gate` runs `bun run check`, `bun run test`, the integration
suites against PostgreSQL 17, NATS JetStream, Valkey, and Gotenberg, the Grids
certification, and an image boot smoke when `packages/cloud` or the
`Dockerfile` changed.
Run the same commands locally before opening a pull request.

An integration suite that starts its own container needs only Docker and its
`CLOUD_TEST_*` targets, so it runs in the gate as well; the Files
stable-reference suite starts a private Filegate this way. The integration job
pulls such images first, with retries, because `docker run` does not retry a
failed pull. When you add a suite like this or change its image, add the image
to that pull step in `.github/workflows/ci.yml`.

`gate` is the only required status check. It needs every other job in
`ci.yml` and passes only when each one reports `success`, or `skipped` for a
path-filtered job listed in its `MAY_SKIP` variable. Any other result fails it
and names the job: `failure`, `cancelled`, `timed_out`, a job skipped behind a
failed `setup`, and `abandoned` from a GitHub Actions outage. A path-filtered
job skipped because `changes` did not succeed fails through the result of
`changes`. The gate fails as well when it receives no job results.

The `ci-gate` check keeps `needs` and `MAY_SKIP` in line with the jobs. A job
may have an `if:` only as a path filter: it needs `changes`, and its condition
reads `needs.changes.outputs`. `scripts/checks/ci-gate.test.ts` runs the gate
step from `ci.yml` against these results. Like the runner, it needs `jq` on
`PATH`.

The gate also builds the production bundle of every application whose package
changed, and of every application when `packages/cloud`, `packages/ui`, or
another shared input changed. The production build rejects code that
development and the tests accept, such as a Bun builtin imported into browser
code. Build one application the same way with:

```bash
NODE_ENV=production APP_ID=grids bun run packages/cloud/scripts/build.ts
```

`bun run test` runs the browser tests in Chromium. The gate's `webkit` job runs
them again in WebKit with `bun run test --browser`, against the Playwright image
as in [Run WebKit locally](#run-webkit-locally). It runs when a workspace with
browser tests or a shared input such as `packages/cloud` or `scripts/` changed.

The nightly workflow repeats the integration suites against PostgreSQL 15, the
oldest supported version, and runs the longer acceptance checks that are too
slow for every pull request. Its `browser-smoke` job builds the Core, gateway,
Grids, and Mail images, boots them against fresh infrastructure, and runs the
Grids and Mail browser smokes against that stack. It runs independently of the
Assistant browser suites, so a failure in one does not hide the other's result.

### Read slow statements from a CI run

The test PostgreSQL in the `integration`, `grids`, and `packed` jobs logs every
completed statement that took 250 ms or longer. For queries whose execution
took as long, `auto_explain` also logs the plan, including queries that run
inside functions. Use these entries when a test got slower in CI but not
locally: they tell a slow database apart from a slow test process.

Find the PostgreSQL log in the job log:

- `integration` and `packed`: open the `Stop containers` step and look for
  `Print service container logs:` followed by the `postgres` container name.
- `grids`: open the `Print the Postgres log and remove containers` step and
  expand the `grids-postgres log` group.

To search it, download the job log and filter it, for example:

```bash
gh run view --job <job-id> --log > job.log
grep -n -A 20 'duration: ' job.log
```

Each entry starts with the time in UTC, the process ID, the database, and the
application name:

- Suites that create their own database show it as `<prefix>_<random>_test`,
  such as `mail_a931..._test`. Suites that use the job's shared database show
  `cloud_ci_test`, `cloud_packed_test`, or `grids_test`; tell them apart by the
  statement text and the time. `CREATE DATABASE` and `DROP DATABASE` also run
  on the shared database.
- Most test connections set no application name and show `[unknown]`.
  Connections that an application opens through its declaration show
  `cloud:<app>`.

A slow query produces a statement entry and a plan entry with the same process
ID. They can come in either order: for a prepared query that returns rows,
the `execute` entry and its parameters come first; for an `INSERT`, `UPDATE`,
or `DELETE` without `RETURNING`, the plan comes first.

```text
2026-10-05 13:12:03.456 UTC [812] mail_a931..._test [unknown]: LOG:  duration: 903.530 ms  execute P...: SELECT ... WHERE mc.mailbox_id = $3 ::uuid
2026-10-05 13:12:03.456 UTC [812] mail_a931..._test [unknown]: DETAIL:  Parameters: $1 = '...', $2 = '...', $3 = '...'
2026-10-05 13:12:03.457 UTC [812] mail_a931..._test [unknown]: LOG:  duration: 903.211 ms  plan:
	Query Text: SELECT ... WHERE mc.mailbox_id = $3 ::uuid
	Query Parameters: $1 = '...', $2 = '...', $3 = '...'
	Nested Loop  (cost=0.84..16.90 rows=1 width=28)
	  ...
```

Not every slow statement has a plan. `auto_explain` times only the execution
of a query, so DDL and other utility statements, such as migrations,
`CREATE DATABASE`, `DROP DATABASE`, `ANALYZE`, or `COMMIT`, and queries that
spent their time in parsing or planning show only the statement entry. The
PostgreSQL 15 of the `grids` job has no `Query Parameters` line in its plans;
read the parameters from the statement entry.

Compare the PostgreSQL time at the start of each entry with the GitHub
timestamps of the test step's output. Ignore the GitHub timestamps in front of
the PostgreSQL lines: the log is printed when the job ends, so they all show
the time of that step.

- Entries in the slow window show which statements took the time. The plan
  shows the chosen strategy with estimated costs; a `JIT:` section means the
  query was compiled. The plan has no actual row counts or timings, so
  reproduce a suspicious plan locally with `EXPLAIN (ANALYZE, BUFFERS)`.
- A statement that fails or is cancelled logs no duration. Look for `ERROR:`
  and `FATAL:` lines in the slow window, such as `canceling statement due to
  statement timeout` or `terminating connection due to administrator command`.
- No `duration:` and no `ERROR:` or `FATAL:` lines in the slow window, while
  the log still starts with the database initialization, mean that no
  statement took 250 ms or longer. The time went to the test process, the
  network, or many shorter statements.
- PostgreSQL logs checkpoints by default. A long checkpoint in the same window
  can point to slow disk writes on the runner.

The log is bounded: Docker keeps two log files of 4 MB for each PostgreSQL
container and drops the oldest entries when both are full. A full local
integration run writes about 0.7 MB, most of it the text of large migrations
that took longer than 250 ms. If the log no longer starts with the database
initialization, entries were dropped. Parameter values are cut after 256 bytes.
