/**
 * Cloud-owned access controls that depend on Cloud principals, permissions,
 * and resource API-key contracts.
 *
 * Portable controls belong in `@k2b/ui`; this focused boundary keeps apps
 * from depending on Cloud's broad legacy UI entrypoint.
 */

export { isManagerEntry, type ManagerCandidate } from "./managers";
export type { AllowedLevel, GrantableLevel } from "./PermissionEditor";
export { default as PermissionEditor } from "./PermissionEditor";
export { default as PrincipalPicker, principalKey } from "./PrincipalPicker";
export { principalLabel } from "./principal-label";
export type {
  ResourceApiKey,
  ResourceApiKeyPermissionOption,
  ResourceApiKeysProps,
} from "./ResourceApiKeys";
export { default as ResourceApiKeys } from "./ResourceApiKeys";
