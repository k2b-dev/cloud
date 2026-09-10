import type { CapabilityExecutionStatus } from "@k2b/cloud/capabilities/store";
import type { CapabilityOpsMessages } from "./ops-messages";

/** Status codes are a stable transport contract; only their presentation is translated. */
export const statusLabel = (status: CapabilityExecutionStatus, t: CapabilityOpsMessages): string => {
  if (status === "succeeded") return t.statusSucceeded;
  if (status === "failed") return t.statusFailed;
  if (status === "denied") return t.statusDenied;
  if (status === "invalid_input") return t.statusInvalidInput;
  if (status === "timed_out") return t.statusTimedOut;
  return t.statusRejected;
};
