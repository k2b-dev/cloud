import { SecretListSchema, secretCheck, writeSecret } from "@k2b/cloud/browser/code-secrets";
import { type CapabilityClientResult, invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities";
import { codePersonName, secretSetter } from "@k2b/cloud/shared";
import { z } from "zod";
import { chatCodeClient } from "./client";
import type { SecretRequestEntry, SecretRequestInput, SecretRequestPorts } from "./secret-request";

// Core's public list limit is 20. Spend at most one batch of 20 page requests per lookup
// (up to 400 rows; byte-bounded pages may contain fewer). Exhaustion fails closed,
// never claiming a name is new. Cursors are opaque: Core owns database collation.
const pageLimit = 20;
const maxPages = pageLimit;

/** Find one name through byte-bounded pages; a list failure never means an empty list. */
export function secretRequestPorts(input: SecretRequestInput, conversationId: string, signal?: AbortSignal): SecretRequestPorts {
  const scope = { conversationId };
  // Use the existing private runtime RPC's ten-second response window; an uncertain write is never replayed.
  const responseSignal = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000));
  const error = (cause: unknown) => ({
    ok: false as const,
    code: typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string" ? cause.code : "UNAVAILABLE",
    status: typeof cause === "object" && cause !== null && "status" in cause && typeof cause.status === "number" ? cause.status : null,
  });
  const found = async (entry: SecretRequestEntry | null) => {
    let title: string | null = null;
    if (input.target) {
      try {
        const read = await invokeCapabilityWithDataSchema(
          { appId: "core", capabilityId: "code.read", kind: "query", input: { codeId: input.target.code }, signal: responseSignal() },
          z.object({ code: z.object({ title: z.string() }) }),
        );
        if (read.ok) title = read.data.data.code.title;
      } catch {
        /* A display title never grants access; list and secretCheck decide entry. */
      }
    }
    return { ok: true as const, entry, title };
  };
  return {
    async list() {
      try {
        if (!input.target) {
          const entry = (await chatCodeClient.secrets(scope)).find((item) => item.name === input.name);
          return {
            ok: true,
            entry: entry
              ? {
                  revision: entry.revision,
                  configured: true,
                  binding: { origin: entry.origin, pathPrefix: "/", headers: [entry.header], prefix: entry.prefix },
                  valueSetAt: null,
                  valueSetBy: null,
                }
              : null,
          };
        }
        let cursor: string | null = null;
        const seenCursors = new Set<string>();
        let pages = 0;
        do {
          if (pages++ >= maxPages) return { ok: false, code: "INVALID_RESPONSE", status: null };
          const listed: CapabilityClientResult<z.output<typeof SecretListSchema>> = await invokeCapabilityWithDataSchema(
            {
              appId: "core",
              capabilityId: "code.secret.list",
              kind: "query",
              input: { codeId: input.target.code, limit: pageLimit, ...(cursor !== null ? { cursor } : {}) },
              signal: responseSignal(),
            },
            SecretListSchema,
          );
          if (!listed.ok) return { ok: false, code: listed.error.code, status: listed.error.status };
          const page: z.output<typeof SecretListSchema> = listed.data.data;
          const entry = page.items.find((item) => item.name === input.name);
          if (entry) {
            // Directory visibility is enforced by the same Core directory that the Code page follows.
            const people = new Map<string, { id: string; name: string }>();
            if (entry.valueSetBy && z.uuid().safeParse(entry.valueSetBy).success) {
              try {
                const response = await fetch(
                  `/api/accounts/entities?${new URLSearchParams({ kinds: "user", user_ids: entry.valueSetBy, per_page: "1" })}`,
                  { credentials: "same-origin", signal: responseSignal() },
                );
                if (response.ok) {
                  const parsed = z
                    .object({
                      items: z.array(
                        z.object({
                          kind: z.string(),
                          user: z
                            .object({ id: z.string(), displayName: z.string(), givenname: z.string(), sn: z.string(), uid: z.string() })
                            .optional(),
                        }),
                      ),
                    })
                    .safeParse(await response.json());
                  for (const item of parsed.success ? parsed.data.items : [])
                    if (item.kind === "user" && item.user)
                      people.set(item.user.id, {
                        id: item.user.id,
                        name: codePersonName({
                          display_name: item.user.displayName,
                          given_name: item.user.givenname,
                          sn: item.user.sn,
                          uid: item.user.uid,
                        }),
                      });
                }
              } catch {
                /* A missing name is "Stored", never a UUID or an access claim. */
              }
            }
            return found({
              revision: entry.binding_revision,
              configured: entry.configured,
              binding: { origin: entry.origin, pathPrefix: entry.pathPrefix, headers: entry.headers },
              valueSetAt: entry.valueSetAt,
              valueSetBy: secretSetter(entry.valueSetBy, people),
            });
          }
          cursor = page.nextCursor;
          if (cursor !== null) {
            if (seenCursors.has(cursor)) return { ok: false, code: "INVALID_RESPONSE", status: null };
            seenCursors.add(cursor);
          }
        } while (cursor !== null && !signal?.aborted);
        if (signal?.aborted) return { ok: false, code: "CANCELLED", status: null };
        return found(null);
      } catch (cause) {
        return error(cause);
      }
    },
    // Like the Code page: the destination check has no response window of its own; only this request's lease ends it.
    check: (binding) =>
      input.target
        ? secretCheck(input.target.code, { origin: binding.origin, pathPrefix: binding.pathPrefix, headers: binding.headers }, signal)
        : Promise.resolve(true),
    async save({ value, revision, binding }) {
      if (signal?.aborted) return { ok: false, code: "CANCELLED", status: null };
      try {
        if (input.target) {
          const written = await writeSecret(
            input.target.code,
            {
              name: input.name,
              value,
              binding_revision: revision,
              ...(binding ? { binding: { origin: binding.origin, pathPrefix: binding.pathPrefix, headers: binding.headers } } : {}),
            },
            responseSignal(),
          );
          return written.ok ? { ok: true } : { ok: false, code: written.error.code, status: written.error.status };
        }
        await chatCodeClient.saveSecret(scope, {
          name: input.name,
          origin: binding?.origin ?? input.origin,
          header: binding?.headers[0] ?? input.header,
          prefix: binding?.prefix ?? input.prefix,
          value,
          expectedRevision: revision,
        });
        return { ok: true };
      } catch (cause) {
        return error(cause);
      }
    },
  };
}
