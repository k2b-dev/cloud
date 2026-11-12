---
title: Mail shared draft capacity
navTitle: Mail shared draft capacity
section: Operations
order: 1200
description: Size Mail collaborative draft connections, recognize overload, and preserve retryable edits.
tags: [mail, operations, collaboration]
updated: 2026-11-12
---

# Mail shared draft capacity

Validate shared drafts under your Mail process's memory and CPU allocation before
enabling them for more mailboxes. The connection limits below bound admission and
queued application work. They do not guarantee total process RSS or capacity for
maximum-size documents, imports, sending, and synchronization at the same time.

## Current validation does not clear broad rollout

A constrained test with separate server and client processes reached a propagation
p95 of **5.04 seconds at 50 drafts × 3 editors** and **13.94 seconds at
200 drafts × 2 editors**. The server had two CPUs and a 1 GiB RSS abort budget;
Postgres had one CPU and 768 MiB. The 200-draft run peaked at 656 MiB server RSS
and released every socket and accounted buffer. These short runs do not prove
long-term memory stability or capacity alongside other Mail workloads.

Broad enablement remains blocked: the target is propagation p95 below one second
at 200 concurrent drafts. SQL work and pool contention dominate this profile;
JetStream publication acknowledgements and network delivery stay below 10 ms p95.
The 512-connection ceiling bounds admission, not usable editing capacity. Verify
latency as well as memory before increasing the number of shared mailboxes.

## Allow room for draft connections

Each Mail process admits at most **512 connections**, with at most **8 peers per
draft in that process**. Connections retain their slots until their SQL work and
subscriptions have stopped. Other replicas enforce their own limits.

The admission model assigns 256 MiB of a 1 GiB process planning budget to
collaboration: 64 MiB each for incoming packets, queued deliveries, and outgoing
native socket buffers; 32 MiB for connection bookkeeping (512 × 64 KiB); and
32 MiB of headroom. Incoming JSON is charged at four times its UTF-8 size to
allow for the parsed packet and queued strings. SQL, Yjs documents, broker
prefetch, native allocations, the rest of Mail, and GC need the remaining memory.
Measure their combined RSS with your document sizes and concurrent workloads.

A connection also has a 16,002,000-byte incoming and outgoing buffer ceiling and
at most 200 queued edit packets or deliveries. Consecutive cursor packets replace
the last unprocessed cursor packet. Document and awareness hub subscribers each
buffer at most one event before the byte-accounted delivery queue. The broker
client has its own bounded prefetch; this is additional to those application
buffers. The last peer leaving a draft retires its hubs.

These limits are fixed, with no new environment variables. Increase verified
capacity through the existing replica and process resource model; test the
result under the same per-process limits.

## Recognize retries and idle connections

When admission or a buffer budget is exhausted, the socket reports `BACKPRESSURE`
and closes with **1013**. The browser keeps pending input and reconnects with
exponential delays from one to 30 seconds. It resumes from its cursor and clears
the error after synchronization succeeds. A slow reader is subject to the same
buffer limits.

A socket must complete its initial replay within ten seconds. If SQL backlog
prevents a reconnect from completing replay, it also closes with
`STREAM_FAILED` / **1012**. This code alone does not identify a broker failure.
Check SQL saturation and replay completion as well as JetStream health. A connection receiving no client
packets for 60 seconds closes with **1012** (`STREAM_FAILED`). Checks run every ten
seconds; busy checks can delay closure. Active browser cursor/awareness packets
keep a connection alive. Request cancellation and Mail shutdown cancel outstanding
SQL work, stop subscriptions, and release slots after cleanup. Reserve one extra
Postgres connection per Mail process for cancellation batches: cancellation must
remain possible when the application SQL pool is fully reserved. This single
connection is closed after the batch completes. Deploy Mail with
its matching browser assets.

## Keep retained storage available

The document topic `cloud:mail:draft-documents` retains at most **1 GiB** and
rejects new events when full. `DRAFT_DOCUMENT_STREAM_FULL` requires resolving
retained-log coverage or storage availability before editing can continue; it
never means that the rejected update was saved. Do not purge uncovered edits to
make room.

The separate awareness topic retains **60 seconds**, up to **64 MiB**. Preserve
its broker sequence state across restarts; follow
[Shared text documents](/en/docs/data/shared-text-documents#preserve-the-awareness-topic-across-restarts)
when moving or recreating it.

Historical revision bases retain at most **12,000,000 bytes per draft**, plus the
pinned current and frozen bases. Postgres table and index overhead is additional.
An evicted revision requires the existing recovery flow. The number of stored
drafts remains governed by mailbox data lifecycle, independently of live socket
admission.
