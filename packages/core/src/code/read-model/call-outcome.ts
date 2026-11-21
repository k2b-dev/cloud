/** Failures that provide no authoritative refusal or result. Shared by recorded and simulated calls. */
export const unknownCodeCallOutcomes = [
  "code_result_unknown",
  "code_test_execution_failed",
  "code_result_exceeds_capability_contract",
  "code_result_not_storable",
  "code_bridge_unavailable",
  "code_file_observation_failed",
  "APP_UNAVAILABLE",
  "GATEWAY_TIMEOUT",
  "INTERNAL_ERROR",
] as const;

export const isUnknownCodeCallOutcome = (code: string): boolean => unknownCodeCallOutcomes.some((value) => value === code);
