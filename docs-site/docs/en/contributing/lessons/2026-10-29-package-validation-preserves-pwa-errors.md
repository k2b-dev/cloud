### General ID validation displaced a PWA declaration error

- **What happened:** The object-store change broke the existing PWA declaration test for invalid app IDs.
- **Root cause:** The new general app/package validation ran before the existing PWA validation and replaced its specific diagnostic with a general naming error.
- **Error class:** Validation-order regression in an existing public declaration contract.
- **Guard:** `define-app.pwa.test.ts` checks the PWA-specific errors and verifies that general ID and reserved-package validation still apply after the PWA check.
