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
  signInExpired: "Secret was not saved because the sign-in expired.",
  unknown: "Secret save outcome is unknown.",
  editorRequired: "Secret entry is unavailable.",
  listFailed: "Secret metadata could not be read. No private entry was opened.",
  destinationRefused: "This destination cannot receive a secret.",
  checkFailed: "The secret destination could not be checked. No private entry was opened.",
} as const;

/**
 * Every hint a `code_secret` result may carry for the model. Fixed sentences only: a host never forwards browser text,
 * so a result cannot carry a value or an exception message.
 */
export const CODE_SECRET_GUIDANCE = {
  editorRequired: "Only people who can edit this automation may enter its secret. Ask an editor; never ask for the value in chat.",
  chatAccess: "This chat no longer accepts the secret. Never send the value in chat.",
  signIn: "Sign in again, then ask for a new secret request. Never send the value in chat.",
  unknown: "Check the current secret metadata before trying again. No entry was replayed; never send the value in chat.",
  keptDestination:
    "The existing secret kept its stored destination, not the requested one. Use that destination in Code, or an editor changes it on the automation's Secrets tab.",
} as const;
