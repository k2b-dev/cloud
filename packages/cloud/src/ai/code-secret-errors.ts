/**
 * Every reason a `code_secret` call ends without a stored value. The timeline keeps a stored failure only when its
 * error is one of these fixed sentences, so its outcome line names the same reason after a reload.
 */
export const CODE_SECRET_ERRORS = {
  expired: "Secret entry is no longer open. No entry was replayed.",
  interrupted: "Secret entry was interrupted. No entry was replayed.",
  notOpened: "Secret entry could not be opened. No value was returned.",
  incomplete: "Secret entry did not complete.",
  accessLost: "Secret was not saved.",
  unknown: "Secret save outcome is unknown.",
  editorRequired: "Secret entry is unavailable.",
  listFailed: "Secret metadata could not be read. No private entry was opened.",
  destinationRefused: "This destination cannot receive a secret.",
  checkFailed: "The secret destination could not be checked. No private entry was opened.",
} as const;
