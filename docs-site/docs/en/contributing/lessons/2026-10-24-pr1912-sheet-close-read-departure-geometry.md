### Closing a sheet read the page's scroll geometry

- **What happened:** Closing a sheet on a phone forced a layout pass although the page had not changed.
- **Root cause:** The close traversed history at the same address, and the page trail snapshotted scroll geometry for that transient entry.
- **Error class:** Transient history reads departure geometry.
- **Guard:** Tests: Cloud `page-trail-runtime.behavior.test.ts` skips same-address geometry reads while retaining click and departure capture; `page-trail.browser.test.ts` preserves URL and scroll through same-address Back.
