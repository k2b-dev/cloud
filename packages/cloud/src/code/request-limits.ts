/** Interactive requests share runner slots and the Code's call budgets. Their deadline includes queueing.
 * Input stays inside the existing 32-KiB run envelope; output inside the 256-KiB run output envelope. */
export const CODE_REQUEST_LIMITS = Object.freeze({
  timeoutMs: 8_000,
  bodyBytes: 8 * 1024,
  publicBodyBytes: 4 * 1024,
  responseBytes: 128 * 1024,
  urlBytes: 2048,
  publicPerMinute: 20,
});
