---
title: Run a speedtest server
navTitle: Speedtest server
section: Operations
order: 1159
description: Run the standalone HTTP speedtest service and optional UDP diagnostics without Cloud infrastructure.
tags: [speedtest, tools, deployment, network]
updated: 2026-11-07
---

# Run a speedtest server

The `@k2b/speedtest` workspace supplies a standalone service and a shared
measurement engine. It needs no Cloud, database, cache, app key or account.
The image is `ghcr.io/k2b-dev/cloud-speedtest`, with the same immutable release
tag as the other release images. Cloud's Compose templates do not start it.

The default measurement target is `https://speedtest.k2b.dev`. Building this
package does not provision that hostname. The operator must provide a working
server or choose another target before directing traffic to it.

## Start and verify the service

Build the dedicated image from the repository root:

```bash
docker build -f packages/speedtest/Dockerfile -t speedtest .
docker run --rm -p 127.0.0.1:8080:8080 speedtest
```

In another terminal, request `http://127.0.0.1:8080/health`; a ready server
returns `ok`. Then run the bundled CLI from a local build, or download the
script from your chosen server:

```bash
curl -fsS https://speedtest.example.com/cli -o speedtest.mjs
node speedtest.mjs --server https://speedtest.example.com --mode quick --json
```

The script requires Node 24 or Bun. Inspect a downloaded script before running
it. `--server` is the measurement service's base URL, without a Cloud path.
HTTPS is required except on loopback. No Cloud credentials are sent.

`--mode quick` allows at most 14 seconds; `--mode accurate` allows at most
29 seconds. Both use four transfer streams and at most one concurrent loaded
ping. stderr shows phase and remaining time; `--locale de` selects German.
`--json` keeps stdout as one JSON result. Ctrl+C cancels active requests.

## Preserve measurement traffic

Terminate HTTPS at your existing ingress and forward HTTP to port `8080`.
Disable caching, compression, response buffering and request buffering for the
measurement routes. Preserve `Content-Length`, CORS, `Retry-After` and the
no-cache response headers. Compression or buffering changes the result.
A reverse proxy needs a streaming upload limit of at least 16 MiB.

The service reads the socket's client IP. It ignores forwarded IP headers
unless the socket peer is in `SPEEDTEST_TRUSTED_PROXIES`, a comma-separated list
of exact IPv4 or IPv6 addresses. Only those proxies may set `X-Real-IP`, and
they must replace any client-supplied value. Without this configuration, all
requests behind one proxy share that proxy's budget.

Run one process per public budget. The in-memory budget resets on restart;
replicas do not share it. An operator adding replicas must enforce the same
aggregate IP budget at ingress. No durable user data is stored.

## Limits and configuration

| Setting | Default | Effect |
| --- | --- | --- |
| `SPEEDTEST_HOST` | `0.0.0.0` | Listen address |
| `SPEEDTEST_PORT` | `8080` | HTTP port |
| `SPEEDTEST_UDP_PORT` | unset | UDP stays disabled until explicitly configured |
| `SPEEDTEST_MAX_ACTIVE` | `128` | Concurrent HTTP transfers; 64 KiB application chunks give an 8 MiB chunk budget |
| `SPEEDTEST_MAX_PEERS` | `4096` | Maximum IP budget records, roughly 1 MiB of ledger storage |
| `SPEEDTEST_UDP_PACKETS_PER_SECOND` | `4096` | Global UDP packet processing ceiling per second |
| `SPEEDTEST_TRUSTED_PROXIES` | empty | Exact proxy addresses allowed to supply `X-Real-IP` |

Each IPv4 address or IPv6 /64 gets 300 combined download/upload starts per 600-second fixed window
and at most ten concurrent HTTP requests. This leaves room for aborting requests at a phase transition. The measurement engine itself opens at most five. Downloads accept up to 25 MiB;
uploads accept up to 16 MiB. A transfer stops after at most 14 seconds, including
clients that stop reading or sending. HTTP `429` means the IP budget is spent;
HTTP `503` means capacity is full. Both include `Retry-After` in seconds.
Expired idle IP records are removed when another address needs a record;
live records are never evicted to admit a new caller.

At higher rates the request budget can stop a test before the time limit.
Treat that result as a failed measurement. Results are estimates of throughput
to the named server, affected by Wi-Fi, other traffic, peering and buffering.

## Optional UDP diagnostics

Set `SPEEDTEST_UDP_PORT=8080` and expose that UDP port only if you want CLI
latency, jitter and packet-loss diagnostics. The browser never uses UDP.

```bash
node speedtest.mjs --server https://speedtest.example.com --udp --udp-port 8080 --json
```

This option selects a separate diagnostic of up to 20 probes within a two-second
deadline; it does not run a throughput test. UDP can be blocked independently
of HTTP. A failed handshake reports an error; no received probes after a
successful handshake yields 100% loss and null latency/jitter.

Forward the configured UDP port to the measurement service at the host named by `--server`; an HTTP-only proxy cannot forward UDP.

All protocol packets are exactly 64 bytes. A short-lived proof binds subsequent
probes to the source address and port. Responses never exceed the request,
including the initial challenge. Confirmed UDP probes have an equal, separate budget of 300 per source network per 600 seconds. Unconfirmed traffic does not allocate peer records. `SPEEDTEST_UDP_PACKETS_PER_SECOND` (default 4096) limits all UDP packet processing per second to bound cryptographic work.

## Read the result

`ping_ms` is the median after one discarded warmup ping. `jitter_ms` is the mean
absolute difference between consecutive ping measurements. Throughput excludes
the first 1.5 seconds per phase in quick mode, or 2 seconds in accurate mode.
Completed 250 ms windows form each result. A stable rate can end a phase early.
`loaded_latency_ms` is the median of pings during download and upload, or null
when none completed. Byte totals include warmup traffic.

These definitions intentionally differ from the older Tools implementation,
which used minimum ping, standard-deviation jitter and throughput including
warmup. JSON retains the existing numeric field names and adds server, mode,
duration, byte totals and stability flags. Do not compare the old and new
values as if the method were unchanged.


## Migrate Cloud Tools clients (breaking)

Cloud no longer serves transfer data or measurement scripts. The legacy
`/tools/api/speedtest/ping`, `/download`, `/upload`, `/cli` and `/cli.py` URLs
return bounded HTTP 410 migration responses with `Cache-Control: no-store`.
They remain declared public routes and do not redirect, forward credentials,
or consume uploaded bodies. Replace automation that uses these URLs.

In Tools application settings, set `tools.speedtest_server` to the standalone
HTTPS base URL (default `https://speedtest.k2b.dev`). HTTP is accepted only on
loopback. Credentials, query strings and fragments are rejected. Set
`tools.speedtest_enabled` to false to disable the Cloud page and CLI using this
installation's settings. The separate server has its own lifecycle; disabling
Tools does not stop that service or independently targeted CLI commands.

The public `GET /tools/api/speedtest/config` returns only `{server, enabled}`
with no-store caching. SSR uses the same settings before rendering the island.
Cloud CLI reads this endpoint from its Cloud profile (at most two seconds for
the lookup); errors fail visibly instead of silently selecting another target.
Without a Cloud profile URL it uses the default measurement server. An explicit
`cld tools speedtest --server https://speedtest.example.com` chooses an
independent measurement target. The global `cld --server …` still selects Cloud.
No Cloud credentials enter either HTTP or UDP measurement transports.

Download `https://speedtest.example.com/cli` to `speedtest.mjs`, then run it with
Node or Bun using `--server https://speedtest.example.com`. Python measurement
scripts have been removed. Check your automation's HTTP status handling:
`curl -f` fails on 410 rather than executing the comment-only migration notice.

The supported workspace entries are `@k2b/speedtest` (engine, plans, progress
and result types), `/browser` (fetch/XHR), `/node` (anonymous HTTP transport),
`/http` (shared HTTP response checks) and `/udp-client` (explicit Node/Bun UDP
diagnostic). Applications import these entries instead of copying transfer loops.
