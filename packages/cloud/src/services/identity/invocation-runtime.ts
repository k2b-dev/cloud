export const invocationIssuanceMode = (): "legacy" | "jwt" => {
  const value = (process.env.CLOUD_INVOCATION_ISSUANCE_MODE ?? "legacy").trim().toLowerCase();
  if (value !== "legacy" && value !== "jwt") throw new Error("CLOUD_INVOCATION_ISSUANCE_MODE must be legacy or jwt");
  return value;
};
