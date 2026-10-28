/**
 * Cloud-owned access controls that depend on Cloud principals, permissions,
 * and resource API-key contracts.
 *
 * Portable controls belong in `@k2b/ui`; this focused boundary keeps apps
 * from depending on Cloud's broad legacy UI entrypoint.
 */

export { type AppAccessEditorProps, default as AppAccessEditor } from "./AppAccessEditor";
export { appAccessAdapter } from "./app-access-adapter";
export { appAccessMessages } from "./app-access-messages";
export { isManagerEntry, type ManagerCandidate } from "./managers";
export type { AllowedLevel, GrantableLevel } from "./PermissionEditor";
export { default as PermissionEditor } from "./PermissionEditor";
export { default as PrincipalPicker, type PrincipalPickerServiceAccount, principalKey } from "./PrincipalPicker";
export { principalLabel } from "./principal-label";
export type {
  ResourceApiKey,
  ResourceApiKeyPermissionOption,
  ResourceApiKeysProps,
} from "./ResourceApiKeys";
export { default as ResourceApiKeys } from "./ResourceApiKeys";
