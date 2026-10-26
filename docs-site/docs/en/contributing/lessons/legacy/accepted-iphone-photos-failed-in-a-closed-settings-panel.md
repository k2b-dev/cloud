### Accepted iPhone photos failed in a closed settings panel

- **What happened:** Tools accepted HEIC files, but browsers without native HEIC support showed no image or visible failure ([#1284](https://github.com/k2b-dev/cloud/issues/1284)).
- **Root cause:** Image loading depended on native browser decoding. Load errors appeared only in a detail panel that was closed for an empty batch or on phones.
- **Error class:** Accepted input that the pipeline cannot process fails silently.
- **Guard:** Every accepted file becomes an image or a visible per-file failure with a recovery hint in the main area. `image-intake/intake.test.ts` checks every accepted type and English and German recovery messages. Converter render and browser tests keep failures in the main area and preserve card order and position. `heif-decoder.test.ts` checks that a decoder that fails to load or crashes ends each waiting file in a visible failure. `image-processor-crop.behavior.test.tsx` checks that drops during a load or a crop are queued or listed, never only reported in the closed side panel.
