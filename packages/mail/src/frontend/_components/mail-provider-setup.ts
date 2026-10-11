type SetupConnection = {
  id: string;
  email: string;
  status: "active" | "degraded" | "revoked";
};

type SetupBinding = {
  connectionId: string;
  state: "pending" | "verifying" | "active" | "degraded" | "revoked";
};

type SetupIdentity = {
  id: string;
  fromAddress: string;
  isDefault: boolean;
  status: "unverified" | "verified" | "rejected" | "disabled";
  pendingVerificationCommandId: string | null;
};

type DefaultSenderSetupState<TIdentity extends SetupIdentity> =
  | { kind: "unavailable" }
  | { kind: "optional" }
  | { kind: "needs-verification"; identity: TIdentity }
  | { kind: "verification-pending"; identity: TIdentity }
  | { kind: "ready"; identity: TIdentity };

export const deriveDefaultSenderSetupState = <TIdentity extends SetupIdentity>(
  connection: SetupConnection | null | undefined,
  binding: SetupBinding | null | undefined,
  identities: readonly TIdentity[],
): DefaultSenderSetupState<TIdentity> => {
  if (!connection || connection.status !== "active" || !binding || binding.connectionId !== connection.id || binding.state !== "active") {
    return { kind: "unavailable" };
  }
  const identity = identities.find(
    (item) => item.status !== "disabled" && item.isDefault && item.fromAddress.toLowerCase() === connection.email.toLowerCase(),
  );
  if (!identity) return { kind: "optional" };
  if (identity.status === "verified") return { kind: "ready", identity };
  return identity.pendingVerificationCommandId ? { kind: "verification-pending", identity } : { kind: "needs-verification", identity };
};
