### Poll cancellation discards an already delivered wakeup

- **What happened:** The Code acceptance suite could wait ten seconds for a run without seeing a terminal state. A real-broker reproduction left one delivery unacknowledged when the event loop resumed after poll expiry; allowing the pull to finish received it immediately.
- **Root cause:** The acquisition poll timer aborted the queue reader, which can unsubscribe before processing a delivery buffered during event-loop contention. That wakeup then waits for the broker's acknowledgement deadline before redelivery.
- **Error class:** A local polling deadline cancels message consumption after broker delivery but before application acknowledgement.
- **Guard:** The scheduling integration regression delays receipt past the existing poll budget and requires the queued run to be leased. Acquisition uses a monotonic deadline and bounded broker pulls, preserving buffered deliveries and caller cancellation without increasing any configured timeout.
