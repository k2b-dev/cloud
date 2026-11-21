import { CODE_REQUEST_LIMITS } from "@k2b/cloud/code";
import type { CodeCheckedVersionManifest } from "@k2b/cloud/contracts";
import { type AuthContext, clientIp, clientIpBucket, ratelimit } from "@k2b/cloud/server";
import { createLoginRedirectUrl } from "@k2b/cloud/shared";
import type { Context } from "hono";
import { isCodePageMember } from "./access";
import { waitCodeRequest } from "./request-deadline";
import type { codeRequestVersion } from "./requests";

/** A person opening the page in the browser, not a script or the page's own island asking for its data. */
export const isCodePageNavigation = (c: Context) =>
  c.req.method === "GET" && !!c.req.header("Accept")?.includes("text/html") && c.req.header("X-Code-Page") !== "tree";

type CodePageVersion = Awaited<ReturnType<typeof codeRequestVersion>>;
type CodeEntrypoint = CodeCheckedVersionManifest["entrypoints"][number];

/** What a request about a Code page may use once it is admitted. */
export type CodePageAdmission = {
  version: CodePageVersion;
  /** The entrypoint the path selected and its route. */
  selected: { entrypoint: string; route: NonNullable<CodeEntrypoint["route"]> };
  isPublic: boolean;
  /** A signed-in person in their own session who is not a guest (`isCodePageMember`). */
  member: boolean;
};

/**
 * The one way into a Code page, for the page itself and for the requests of its label: the route the path selects,
 * public or for members, no guest on a page that is not public, a session and never a workload credential, and the
 * request budget. Missing and inaccessible Code answer alike (`code_route_not_found`). Each caller keeps its own
 * budget under its own rate-limit IDs with the page's limits. Refusals are stable codes; hosting turns them into a
 * page for a browser navigation (`isCodePageNavigation`).
 */
export async function admitCodePage<E extends AuthContext>(
  c: Context<E>,
  input: {
    codeId: string;
    path: string;
    signal: AbortSignal;
    version: (codeId: string) => Promise<CodePageVersion>;
    select: (manifest: CodeCheckedVersionManifest, path: string) => CodeEntrypoint | undefined;
    limits: { member: string; public: string };
  },
): Promise<CodePageAdmission | Response> {
  const version = await waitCodeRequest(input.version(input.codeId), input.signal);
  const entry = input.select(version.manifest, input.path);
  if (!entry?.route) return c.json({ code: "code_route_not_found" }, 404);
  const selected = { entrypoint: entry.entrypoint, route: entry.route };
  const isPublic = selected.route.public;
  const actor = c.get("actor");
  const subject = c.get("accessSubject");
  // Interactive pages require a signed-in person. Workload credentials never impersonate a visitor.
  if (
    !isPublic &&
    (c.get("credentialKind") !== "session" || actor?.kind !== "user" || subject?.type !== "user" || subject.userId !== actor.user.id)
  ) {
    // A visitor who opens the page goes to sign-in and comes back to it, as on every Cloud page.
    if (!actor && isCodePageNavigation(c)) return c.redirect(createLoginRedirectUrl(c.req.url));
    return c.json({ code: "code_sign_in_required" }, 401);
  }
  // Pages that are not public belong to the Cloud's members, whoever owns the Code: they run with the owner's
  // rights, which no guest account was given. A guest is refused before the Code is asked.
  if (!isPublic && actor?.kind === "user" && actor.user.profile === "guest") return c.json({ code: "code_members_only" }, 403);
  if (!isPublic && actor?.kind === "user") {
    const limiter = ratelimit({ id: input.limits.member, windowSecs: 60, limit: CODE_REQUEST_LIMITS.publicPerMinute });
    if ((await waitCodeRequest(limiter.check(`user:${actor.user.id}`), input.signal)).limited) {
      c.header("Retry-After", "60");
      return c.json({ code: "code_request_rate_limit" }, 429);
    }
  }
  if (isPublic) {
    const limiter = ratelimit({ id: input.limits.public, windowSecs: 60, limit: CODE_REQUEST_LIMITS.publicPerMinute });
    if (
      (await waitCodeRequest(limiter.check(`ip:${clientIpBucket(clientIp(c))}`), input.signal)).limited ||
      (await waitCodeRequest(limiter.check(`code:${input.codeId}`), input.signal)).limited
    ) {
      c.header("Retry-After", "60");
      return c.json({ code: "code_request_rate_limit" }, 429);
    }
  }
  return {
    version,
    selected,
    isPublic,
    member: isCodePageMember({ actor, accessSubject: subject, credentialKind: c.get("credentialKind") }),
  };
}
