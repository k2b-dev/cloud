import { getApp } from "@k2b/cloud";
import {
  invokeCodeAccess,
  signCodeAccessCleanup,
  signCodeAccessList,
  signCodeAccessNotifications,
  signCodeAccessProof,
} from "@k2b/cloud/capabilities/server";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  CODE_ACCESS_MAX_MANAGER_USER_IDS,
  type CodeAccessGrant,
  CodeAccessListDataSchema,
  type CodeAccessSetData,
  CodeAccessSetDataSchema,
} from "@k2b/cloud/contracts";
import { z } from "zod";
import type { CodeContext } from "./access";
import type { CodeActivationTarget } from "./activation-plan";
import { targetApp } from "./activation-plan";
import { activationDecision } from "./activation-presentation";

/** A transport refusal is definitive; unavailability or an ambiguous response retries with the persisted grantId. */
export class CodeActivationTransportError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}
async function body(response: Response): Promise<unknown> {
  if (!response.body) throw new CodeActivationTransportError("target_unavailable", true);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > CAPABILITY_MAX_RESULT_BYTES) throw new CodeActivationTransportError("target_response_invalid", true);
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(combined));
  } catch {
    throw new CodeActivationTransportError("target_response_invalid", true);
  }
}
async function decode<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new CodeActivationTransportError(
      `target_http_${response.status}`,
      response.status >= 500 || response.status === 429 || response.status === 408,
    );
  }
  const parsed = z.object({ data: schema }).safeParse(await body(response));
  if (!parsed.success) throw new CodeActivationTransportError("target_response_invalid", true);
  return parsed.data.data;
}
/** Core-only effect seam. Tests replace the network, never the activation journal or transaction boundaries. */
export type CodeActivationTransport = {
  set: (
    input: {
      codeId: string;
      versionId: string;
      activationId: string;
      activatingPerson: string;
      principal: string;
      item: CodeActivationTarget;
      dryRun: boolean;
    },
    context: CodeContext,
  ) => Promise<CodeAccessSetData>;
  /** Server-only recipients, separately authorized; never attach them to a plan or person-visible failure. */
  notificationManagers: (input: Omit<Parameters<CodeActivationTransport["set"]>[0], "dryRun">) => Promise<string[]>;
  list: (appId: string, principal: string) => Promise<CodeAccessGrant[]>;
  remove: (appId: string, principal: string, grantId: string) => Promise<void>;
};
async function authorityRequest(
  appId: string,
  operation: "list" | "rm" | "ownerTitle",
  principal: string,
  input: unknown,
): Promise<Response> {
  const app = await getApp(appId);
  if (!app) throw new CodeActivationTransportError("target_unavailable", true);
  const token = operation === "rm" ? await signCodeAccessCleanup(appId, principal) : await signCodeAccessList(appId, principal);
  return fetch(
    new URL(
      `/api/_internal/capabilities/v1/code-authority/${operation === "rm" ? "actions" : "queries"}/${operation === "ownerTitle" ? "code.owner.title" : `code.access.${operation}`}`,
      app.baseUrl,
    ),
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  );
}
export const codeActivationTransport: CodeActivationTransport = {
  set: async ({ item, dryRun, ...input }, context) => {
    const appId = targetApp(item.target);
    const proof = await signCodeAccessProof(appId, { ...input, grantId: item.grantId, target: item.target, operations: item.operations });
    return activationDecision(
      await decode(
        await invokeCodeAccess({
          request: new Request("http://core.invalid/api/code/activate"),
          appId,
          operation: "set",
          input: { proof, target: item.target, operations: item.operations, dryRun },
          authority: context.authority,
          locale: context.locale,
        }),
        CodeAccessSetDataSchema,
      ),
      context.locale,
    );
  },
  notificationManagers: async ({ item, ...input }) => {
    const appId = targetApp(item.target);
    const app = await getApp(appId);
    if (!app) throw new CodeActivationTransportError("target_unavailable", true);
    const token = await signCodeAccessNotifications(appId, {
      ...input,
      grantId: item.grantId,
      target: item.target,
      operations: item.operations,
    });
    const data = await decode(
      await fetch(new URL("/api/_internal/capabilities/v1/code-authority/queries/code.access.notifications", app.baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      }),
      z.object({ managerUserIds: z.array(z.uuid()).max(CODE_ACCESS_MAX_MANAGER_USER_IDS) }).strict(),
    );
    return data.managerUserIds;
  },
  list: async (appId, principal) => decode(await authorityRequest(appId, "list", principal, { principal }), CodeAccessListDataSchema),
  remove: async (appId, principal, grantId) => {
    const result = await decode(await authorityRequest(appId, "rm", principal, { grantId }), z.object({ removed: z.boolean() }));
    // False is ambiguous (missing OR refused). List before considering cleanup complete.
    if (!result.removed && (await codeActivationTransport.list(appId, principal)).some((entry) => entry.grantId === grantId))
      throw new CodeActivationTransportError("target_cleanup_refused", true);
  },
};
/** Core-only, title-only reader projection under the exact owning Code account. No session is retained. */
export async function readCodeResourceOwnerTitle(ref: { type: string; id: string }, principal: string): Promise<string | null> {
  return (
    await decode(
      await authorityRequest(targetApp(ref), "ownerTitle", principal, ref),
      z.object({ title: z.string().min(1).max(500).nullable() }).strict(),
    )
  ).title;
}
