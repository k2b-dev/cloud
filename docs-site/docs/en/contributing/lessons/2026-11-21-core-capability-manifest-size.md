### Core's capability manifest grew to 233 bytes below its limit

- **What happened:** Core's registry manifest reached 409,367 of 409,600 bytes. One more Query or Action in Core would have stopped Core from starting. One open pull request already added 209 more bytes.
- **Root cause:** The schema projection inlines every repeated subschema. The chart transport passes through JSON Schema and back, so all 22 chart kinds repeated the same option groups: 63.6 KB for one Query. Geo provenance repeated in every address, stop, leg and candidate. No check reported the remaining room, so the manifest grew unnoticed.
- **Error class:** A size-limited record that grows with every feature and is measured only by its hard limit.
- **Guard:** The `capability-manifest-size` rule fails when any app's manifest leaves less than 24 KiB below the registry limit. Its finding names the largest entries.
