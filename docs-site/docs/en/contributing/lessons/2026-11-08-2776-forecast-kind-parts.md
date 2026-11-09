### Keep forecast drawing in its own chart part

- **What happened:** The detailed line renderer exceeded the new per-kind allowance and added line-only code to the shared chart asset.
- **Root cause:** Its import graph retained the ordinary line fallback, duplicate SVG helpers and full zoned-date conversion even though portable date coordinates are already mapped to UTC.
- **Error class:** A lazy leaf retains code needed only by its general-purpose facade.
- **Guard:** The part-size, shared-size, marker-ownership and host-total assertions remain strict. The line facade keeps ordinary output and arbitrary-zone conversion; the forecast part uses the same detail renderer and calendar math with UTC conversion. Line-only path helpers live outside the shared SVG module. Strict parity, time-axis tests and offline first-use tests cover both paths; the Code catalog example passes the real model-facing schema.
