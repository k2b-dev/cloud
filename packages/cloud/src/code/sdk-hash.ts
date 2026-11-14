import { capabilityHash } from "../_internal/capability-schemas";
import type { GeneratedCodeSdk } from "./types";

/** Canonical SHA-256 of the complete generated SDK, identical to CodeVersionManifest.hashes.sdk.
 * Hosts compare this before interpreting calls against SDK metadata; JSON object key order is immaterial. */
export const codeSdkHash = (sdk: GeneratedCodeSdk): string => capabilityHash(sdk);
