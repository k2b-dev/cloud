---
id: tools-speedtest
title: Measure your connection
kind: task
icon: ti ti-gauge
description: Measure download, upload, ping, jitter and latency under load against the named server.
order: 115
---

## Run a test {icon="player-play"}

Open **Speed test**, check the **Measurement server**, then choose
**Quick · 14 s** or **Accurate · 29 s**; that is the longest a test can take.
Press **Start test**.
The test runs ping, download and upload in order. The remaining time decreases;
a stable result can finish early. **Stop** cancels the active transfers.

The server receives anonymous test traffic and sees your IP address. The test
sends no Cloud credentials or personal files. Other traffic, Wi-Fi and the
route to the selected server affect the result. It is not a measurement of
every destination on the internet.

The measurement server also offers its own public page, without signing in.
Browser, CLI and scripts share a limit of two test starts per internet
connection in any rolling 60 seconds. Cancelled starts count. People behind
the same office connection share the limit; IPv6 uses a /64 network. After
two starts, the countdown shows when you can run another test.

## Read and keep the result {icon="chart-line"}

The large reading shows the download; the tiles show upload, ping, jitter and
loaded latency. The terminal shows the same measurements. The history draws the
initial ramp-up as a thin gray line; it is excluded from the throughput. Ping is the median; jitter is the mean difference between
consecutive pings. **Loaded latency** measures response time during transfers.
A dash means no completed sample is available. The time axis stays fixed while
the test runs, then ends at its actual duration. Long terminal lines stay on
one line and scroll horizontally.

After **Done**, use **Copy result** for JSON. **--json** shows it in the terminal
panel; it does not start a second measurement. **Run again** starts a fresh test.

## Recover from a failed test {icon="refresh"}

- Offline: reconnect, then press **Start test**.
- Unreachable or slow server: check the connection and use **Try again**.
- Two tests started: wait for the displayed countdown, then use **Try again**.
- Server busy: wait for the countdown. A refused start does not consume your allowance.
- Server bandwidth budget reached: the test has no valid result. Try again later.
- Disabled or invalid server address: contact your Cloud operator.

## Use your terminal {icon="terminal"}

Choose **Cloud CLI**, **Node** or **Bun** and copy the command. The scripts now
come from the standalone measurement server, not Cloud. Python scripts are no
longer supplied. Download the script before executing it.

`cld tools speedtest` uses the Cloud profile's server settings when a profile
has a Cloud URL; without one, it uses `https://speedtest.k2b.dev`.
`cld tools speedtest --server https://speedtest.example.com --mode accurate --json`
explicitly selects an independent target. Progress goes to stderr; stdout
contains only the final structured result. Ctrl+C cancels.

Only an explicit `--udp` runs the separate UDP jitter and packet-loss diagnostic.
It does not measure throughput. Browser tests and the default CLI never use UDP.
