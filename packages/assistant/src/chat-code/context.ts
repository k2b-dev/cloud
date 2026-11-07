import type { RequestAuthority } from "@k2b/cloud/server";
import type { ArtifactIdentity } from "./identity";
export type CodeToolContext = ArtifactIdentity & {
  /** Resolved by invocation middleware; retains credential caps and mobile provenance. */
  authority?: RequestAuthority | null;
  locale: string;
  timeZone: string;
  theme?: "light" | "dark";
  signal: AbortSignal;
  review?: boolean;
  capabilityToken?: string;
};
