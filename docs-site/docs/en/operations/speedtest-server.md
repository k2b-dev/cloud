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
| `SPEEDTEST_CAPACITY_MBPS` | `1000` | Sustainable aggregate measurement budget, combined download and upload |
| `SPEEDTEST_TEST_MBPS` | `1000` | Capacity reserved per admitted test |
| `SPEEDTEST_MAX_ACTIVE` | `128` | Stream memory ceiling; ten slots are reserved per admitted test, including cancellation headroom |
| `SPEEDTEST_MAX_PEERS` | `4096` | Maximum IP budget records, roughly 1 MiB of ledger storage |
| `SPEEDTEST_UDP_PACKETS_PER_SECOND` | `4096` | Global UDP packet processing ceiling per second |
| `SPEEDTEST_TRUSTED_PROXIES` | empty | Exact proxy addresses allowed to supply `X-Real-IP` |

Each canonical IPv4 address or IPv6 /64 may start at most **two complete tests
in any rolling 60-second interval**. A cancelled test still counts. Rejection
because the server is full does not consume a start. Shared connections, such
as an office NAT, share this allowance. HTTP 429 includes the seconds until
the oldest counted start expires; the UI and CLI display that waiting time.

The engine requests admission with `POST /session?mode=quick` (or `accurate`).
Its unpredictable, short-lived ticket travels in `X-Speedtest-Token`, never a
cookie or URL. Downloads and uploads without a valid ticket are rejected.
The ticket is bound to the source network, lasts at most 14 or 29 seconds,
and permits ten overlapping requests for four streams plus loaded ping and
cancellation headroom. `POST /session/end` releases the reserved place;
expiry also releases it after disconnects. Clients cannot extend a ticket.
Static page and CLI downloads do not consume a test start.

### Derive capacity before exposing the server

Measure the sustainable capacity available to this service after reserving
headroom for the host and other workloads. Set `SPEEDTEST_CAPACITY_MBPS` to
that available capacity and `SPEEDTEST_TEST_MBPS` to the desired reservation
per test. Admission uses:

```text
maximum concurrent tests = min(floor(capacity Mbps / test Mbps),
                               floor(maximum active streams / 10))
```

For example, a measured 10 Gbit/s link with 2 Gbit/s reserved for other work
has an 8000 Mbit/s measurement budget. Reserving 2000 Mbit/s per test admits
four tests. With ten 64 KiB stream slots per test, this reserves 2.5 MiB of
application download chunks; socket and ingress buffers require additional
memory. The defaults (1000/1000, one test) are a local starting configuration,
not a measured claim about `speedtest.k2b.dev`. Reject configurations that
cannot admit one test. Increase capacity only after measuring the host.

A process-wide byte bucket accounts for both outgoing download chunks and
incoming upload chunks. Its refill rate is `capacity Mbps × 1000000 / 8`
bytes/second with a one-second burst allowance. Exhaustion fails the test;
a truncated download never becomes a successful measurement. HTTP 503 and
`Retry-After` report an unavailable server. This budget does not pace traffic
and silently report an imposed ceiling as the client's speed.

Application code cannot undo bytes already received from the network.
Configure an aggregate ingress bandwidth ceiling and upload body limit at the
proxy/host as well; the application bucket bounds accepted measurement work.
Disable compression and buffering, preserve `X-Speedtest-Token` and its CORS
preflight, and apply an ingress connection/request budget for static assets,
public ping and rejected requests. This service is not a network firewall.

Downloads accept up to 25 MiB; uploads accept up to 16 MiB. Each transfer stops
after at most 14 seconds or the ticket's remaining lifetime, whichever is
shorter. The IP ledger has at most `SPEEDTEST_MAX_PEERS` records. Expired
records are reclaimed without evicting a live budget. The complete-test limit
is shared by the public page, Cloud Tools, CLI and downloaded scripts.

Results estimate throughput to the named server and depend on Wi-Fi, other
traffic, peering and buffering. A capacity failure is not a completed result.

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
including the initial challenge. Confirmed UDP probes have a separate packet budget of 300 per source network per 600 seconds. Unconfirmed traffic does not allocate peer records. `SPEEDTEST_UDP_PACKETS_PER_SECOND` (default 4096) limits all UDP packet processing per second to bound cryptographic work.

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
