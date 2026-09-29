---
title: Testing
navTitle: Testing
section: Contributing
order: 1304
description: Run unit, render, and integration tests locally, and understand what the pull request gate and nightly run check.
tags: [contributing, testing, ci]
updated: 2026-09-29
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
service API contracts, localization, CSS architecture, formatting, the
application set, and every package typecheck. A package typecheck covers its
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

Import heavy components once at module scope, not inside the first test: the
first import runs the Solid transform over the component's source graph, and
that time otherwise counts against the 5 s test timeout.

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

A direct `bun test` loads the dotenv files of its working directory. With a
`CLOUD_TEST_*` variable set, the fixture refuses such a process when a file
like `.env` exists there. Start a direct run from that directory with
`BUN_OPTIONS=--no-env-file bun test …`: unlike `bun --no-env-file test`, the
variable also reaches the Bun processes that tests and package scripts start.

The database name must end in `_test`. Integration tests create and delete
rows; the fixture refuses any other name. Never point them at the development
database.

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
configured.

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
per minute answers 429 at random. `rateLimit()` counts an anonymous request
without `x-forwarded-for` as the address `unknown`, which every such request
shares.

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

The gate also builds the production bundle of every application whose package
changed, and of every application when `packages/cloud`, `packages/ui`, or
another shared input changed. The production build rejects code that
development and the tests accept, such as a Bun builtin imported into browser
code. Build one application the same way with:

```bash
NODE_ENV=production APP_ID=grids bun run packages/cloud/scripts/build.ts
```

The nightly workflow repeats the integration suites against PostgreSQL 15, the
oldest supported version, and runs the longer acceptance checks that are too
slow for every pull request. Its `browser-smoke` job builds the Core, gateway,
Grids, and Mail images, boots them against fresh infrastructure, and runs the
Grids and Mail browser smokes against that stack. It runs independently of the
Assistant browser suites, so a failure in one does not hide the other's result.
