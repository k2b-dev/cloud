import type { RequestActor } from "../../contracts/shared";

export const mailBackoffMs = (attempt: number): number => Math.min(60_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 6), 60 * 60_000);
export const mailMessageId = (id: string, address: string): string => `<${id}@${address.slice(address.lastIndexOf("@") + 1)}>`;
export const mailEnvelope = (profile: { fromAddress: string; fromName: string | null }, appName: string, fromName?: string | null) => ({
  from: { address: profile.fromAddress, name: fromName ?? profile.fromName ?? appName },
  envelope: { from: profile.fromAddress },
});
export const mailActorSnapshot = (actor?: RequestActor) => {
  if (!actor) return undefined;
  return actor.kind === "user"
    ? { type: actor.kind, id: actor.user.id, name: actor.user.displayName || actor.user.uid }
    : { type: actor.kind, id: actor.serviceAccount.id, name: actor.serviceAccount.name };
};
