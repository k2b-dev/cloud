import { isServiceError } from "@k2b/stdlib";
import type {
  CapabilityAppExecutionContext,
  CapabilityDefinitions,
  CapabilityExecutionContext,
  ResourceReadableInput,
} from "../contracts/capabilities";
import { sql } from "../runtime/clients";
import type { RequestActor } from "../server/middleware/auth";
import { resolveResourceReaders } from "../services/identity/resource-readers";
import { readIdentityGroupsAdmin } from "../services/identity/runtime-config";
import { serviceAccounts } from "../services/service-accounts";
import { loadCurrentUser } from "../services/session/user";

/** An event place already has an ordinary permission-aware reader. Project its success,
 * never its content, through the existing app-only readability contract. */
export function eventPlaceReader(definitions: CapabilityDefinitions, localType: string) {
  if (!Object.values(definitions.events ?? {}).some((event) => event.place === localType)) return undefined;
  const type = definitions.types?.[localType];
  if (type?.container) return undefined;
  const query = type?.reader && definitions.queries?.[type.reader];
  if (!query || query.stream || !query.run) return undefined;
  return async (input: ResourceReadableInput, context: CapabilityAppExecutionContext) => {
    const parsed = query.input.safeParse({ id: input.id });
    if (!parsed.success) return [];
    const readable: ResourceReadableInput["principals"] = [];
    const readers = await resolveResourceReaders(input.principals);
    const groupsAdmin = [...(await readIdentityGroupsAdmin(sql))];
    for (const reader of readers) {
      context.signal.throwIfAborted();
      const user = reader.subject.type === "user" ? await loadCurrentUser({ userId: reader.subject.userId, groupsAdmin }) : null;
      let actor: RequestActor;
      if (reader.principal.type === "user") {
        if (!user) continue;
        actor = { kind: "user", user };
      } else {
        const account = await serviceAccounts.get({ id: reader.principal.serviceAccountId });
        if (!account || account.status !== "active") continue;
        if (account.kind === "user_delegated") {
          if (!user || account.delegatedUserId !== user.id) continue;
        } else if (reader.subject.type !== "service_account" || reader.subject.serviceAccountId !== account.id) continue;
        actor = {
          kind: "service_account",
          serviceAccount: account,
          delegatedUser: user,
          scopes: ["read"],
          credentialId: null,
          oauthClientId: null,
          credentialExpiresAt: null,
        };
      }
      const authority = { actor, accessSubject: reader.subject, credentialKind: "invocation" as const, scopes: ["read"] };
      const projected: CapabilityExecutionContext = {
        actor,
        accessSubject: reader.subject,
        user,
        authority,
        locale: context.locale,
        requestId: context.requestId,
        origin: context.origin,
        signal: context.signal,
      };
      // No app authority, cross-app query callback, credential or effect operation is forwarded.
      try {
        const result = await query.run(parsed.data, projected);
        if (result.ok) readable.push(reader.principal);
        else if (!["FORBIDDEN", "NOT_FOUND", "APP_ACCESS_DENIED"].includes(result.error.code))
          throw new Error(`Event place reader unavailable: ${result.error.code}`);
      } catch (error) {
        if (isServiceError(error) && ["FORBIDDEN", "NOT_FOUND", "APP_ACCESS_DENIED"].includes(error.code)) continue;
        throw error;
      }
    }
    return readable;
  };
}
