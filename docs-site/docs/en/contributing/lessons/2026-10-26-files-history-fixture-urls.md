---
title: Isolated Filegate lease URLs
navTitle: Isolated Filegate lease URLs
section: Contributing
order: 1607
description: Match issued test leases to the daemon's published host port.
tags: [contributing, testing]
updated: 2026-10-26
---

# Isolated Filegate lease URLs

- **Class:** Container metadata calls work while issued direct leases target an unreachable port.
- **What goes wrong:** The fixture publishes a random host port but advertises port 4000. An explicitly configured local daemon bypasses that setup.
- **Guard:** The isolated fixture chooses one host port for its public URL and Docker mapping. Administrative download and stable-ID history integration tests consume actual issued leases.
- **Evidence:** Run the Files history integration suites without `CLOUD_TEST_FILEGATE_URL`, so they start their own daemon and exercise its public URLs.
