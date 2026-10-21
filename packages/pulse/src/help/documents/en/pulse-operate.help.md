---
id: pulse-operate
title: Check collection and recover a base
icon: ti ti-lifebuoy
kind: reference
description: Check source status, retry ingest safely, and recover failed or blocked bases.
order: 140
---
Open **Sources** when expected data is missing. Check the source before changing or clearing the base.

## Read source status

:::reference
- **Newest data:** The latest timestamp received from the source. Compare it with the time you expect.
- **Throttling:** Recent value or byte limits stopped collection. Reduce the batch or wait for the retry delay.
- **Refused histograms:** A family failed validation. Check its buckets, count, and sum at the endpoint.
- **Skipped summaries:** Prometheus summary samples are not stored. Select supported metric families instead.
- **Errors:** Check the last error and its time. Scrape history adds success, received counts, duration, and finish time.
:::

For an internal endpoint, ask the Cloud administrator to allow its host, host:port, or CIDR under **Administration → Pulse → Internal targets**.
Changing the endpoint's scheme, host, or port deletes its stored bearer token unless you supply a replacement.

## Set the expected arrival of data

For a source that sends data, open **Edit → Expected data**. Choose a regular interval in seconds, a daily time, or **No expectation**. Daily times use the base's timezone. An expectation refers to the newest data timestamp, not the last contact; it cannot prove that a whole day's data arrived.

If someone changes the source while you edit, Pulse keeps your entries and blocks another save. Close and reopen the source to review its current settings. If creating a source ends with an unknown result, choose **Check sources** before creating it again.

## Recover the overview

**Retry** reloads a failed overview. During a store outage, existing values remain dated; an unavailable value is not zero. If access was removed, ask a base administrator to restore it. Retrying does not restore access.

## Retry HTTP ingest safely

Send batches to `POST /api/pulse/ingest` with the source token as a Bearer credential.
Send an `Idempotency-Key` from the first attempt. Keep the body and key unchanged for retries.

:::reference
- **Batch size:** At most 500 metrics, 500 events, and 500 states; 1,500 items total and 5 MiB of encoded batch JSON.
- **Request key:** Pulse reserves it before writing. The same key and batch return the same successful result for 24 hours.
- **Pending batch:** Retry with the same key to write the same rows. Different content with that key returns 409.
- **No key:** A failed batch can already be partly stored; the error says so. Sending it again can store those parts twice. Adding a key afterwards cannot deduplicate the first attempt. Send every batch with an `Idempotency-Key` from the first attempt to retry safely.
- **Quota:** Values and bytes share a per-base allowance across sources and replicas. A batch larger than one minute's allowance can use a full bucket; its full cost delays later batches until enough quota has refilled. A 429 response includes `Retry-After`.
- **Store outage:** A 503 response includes `Retry-After`. Scrapes record the failure; Cloud administrators receive one notification per outage.
:::

Wait for the stated delay before repeating a keyed batch. A future-time error names the item to correct.
The CLI ingest command has no key flag. Use the source-token HTTP route when delivery needs safe retries.
`cld pulse source-tokens create --output-file <path>` saves a token in a new private file and never prints it.

## Recover capacity or a base

A base administrator changes sources, access, and retention. Cloud administrators connect the store and set base policy, limits, and internal targets.
The operator supplies a dedicated ClickHouse instance. Without it, **Pulse is not set up yet** appears; other Cloud apps remain available.

:::reference
- **Base storage full:** New values return 409; reads continue. Shorten retention or ask a Cloud administrator to raise the threshold.
- **Instance disk below 10% free:** New values return 503 with a retry delay. Reads continue; Cloud administrators receive a notification.
- **Shorter retention:** Review the cutoff, affected rows, and estimated bytes before confirming. Sensitive fields are cleared while their event rows remain.
- **Hourly values are lagging:** This notice under **Administration → Pulse → Bases** means calculation or sealing is delayed. Check those jobs before clearing data.
- **Failed operation:** A new base must become active first. Choose **Retry** after provisioning, clearing, or deletion fails.
- **Blocked writes:** A missing database or checkpoint mismatch needs a matching restore and a Cloud administrator's **Check again**. Clearing stays blocked meanwhile.
:::

:::warning Clearing and recreating discard measurements
Clearing keeps sources, tokens, settings, and access. A Cloud administrator's **Start empty** also starts with empty measurements.
Deleting revokes tokens, prevents database reads, and then removes the base. These operations cannot be undone in Pulse.
:::

A deleting base remains on its administrators' overview until deletion finishes.
Check the operation's state before treating an accepted request as completed work.
