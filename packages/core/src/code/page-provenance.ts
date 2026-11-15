import { sql } from "@k2b/cloud";
import { getCapabilityCatalogApp } from "@k2b/cloud/capabilities/server";
import { cloudResourceRefAppId } from "@k2b/cloud/contracts";
import { codeOwnerKindTitle, type RequestAuthority } from "@k2b/cloud/server";
import {
  type CodeContext,
  CodeOwnerUnavailableError,
  type CodePageViewerAuthority,
  codePageOwnerPersonName,
  codePermission,
  isCodePageMember,
  readCodeOwner,
} from "./access";
import type { Code } from "./contracts";
import type { CodePageAdmission } from "./page-admission";
import type { CodePageLabel, CodePageOwner, CodePageProvenance } from "./page-provenance-contracts";
import type { CodeRequestOwner } from "./requests";
import { findCode } from "./store";

/** The contract bounds every name to 200 characters; a longer display name is cut, never refused. */
const clip = (value: string) => value.slice(0, 200);

/**
 * The pill in the first paint, for this viewer, from the owner the version statement already read. Members see who
 * owns the page (F26 for a person); for a resource only its type, never its name. Visitors without an account,
 * guests, workload credentials and owners the registry cannot tell see "Selbst gebaute Seite" (`anonymous`).
 */
export async function codePageLabel(owner: CodeRequestOwner, viewer: CodePageViewerAuthority, locale: string): Promise<CodePageLabel> {
  if (!isCodePageMember(viewer)) return { kind: "anonymous" };
  if (owner.kind === "person") {
    const name = codePageOwnerPersonName(viewer, owner.name);
    return name ? { kind: "person", name: clip(name) } : { kind: "anonymous" };
  }
  const title = await codeOwnerKindTitle(owner, locale);
  if (!title) return { kind: "anonymous" };
  return owner.kind === "app" ? { kind: "app", name: clip(title) } : { kind: "resource", type: clip(title) };
}

/** The running version changed between delivering the page and asking about it. */
export class CodePageChangedError extends Error {
  constructor() {
    super("code_page_changed");
  }
}

/** What the card shows to a visitor: nothing about the owner, the automation or the account. */
const VISITOR: CodePageProvenance = { viewer: "visitor", owner: null, automation: null, gives: "nothing", report: null };

/**
 * The card's facts for one viewer after `admitCodePage` let the request in and its version value matched. Visitors
 * learn nothing new. Members learn who owns the page: a person by name (F26), an app by name, a resource by type and
 * by name only when the owner's reader names it to them. Readers of the Code (`codePermission`) also learn the
 * automation; the right to the Code never lets them read the owner's name by itself.
 */
export async function readCodePageProvenance(input: {
  codeId: string;
  path: string;
  admission: CodePageAdmission;
  /** The member's authority; null for everyone else. */
  authority: RequestAuthority | null;
  locale: string;
  signal: AbortSignal;
}): Promise<CodePageProvenance> {
  const { admission, authority } = input;
  if (!admission.member || !authority) return VISITOR;
  const context: CodeContext = { authority, locale: input.locale, signal: input.signal };
  const code = await findCode(input.codeId);
  if (!code || code.state !== "active" || code.activeVersionId !== admission.version.versionId) throw new CodePageChangedError();
  // One owner read per card: the permission check and the "Gehört zu" row ask the same provider.
  let ownerRead: ReturnType<typeof readCodeOwner> | undefined;
  const readOwner = () => {
    ownerRead ??= readCodeOwner(code.owner, context);
    return ownerRead;
  };
  const permission = await codePermission(code, context, sql, "read", readOwner).catch((error: unknown) => {
    if (error instanceof CodeOwnerUnavailableError) return null;
    throw error;
  });
  const owner = await cardOwner(admission.version.owner, authority, input.locale, readOwner);
  const [report] = await sql<{ created_at: Date }[]>`SELECT created_at FROM code.page_reports
    WHERE reporter_id=${authority.accessSubject.type === "user" ? authority.accessSubject.userId : null}::uuid
      AND code_id=${code.id} AND path=${input.path} AND state='open'`;
  return {
    viewer: permission ? "reader" : "member",
    owner,
    automation: permission ? await cardAutomation(code, admission.version.versionId, owner, authority, input.locale) : null,
    gives: admission.isPublic ? "nothing" : "account",
    report: { reportedAt: report ? report.created_at.toISOString() : null },
  };
}

async function cardOwner(
  owner: CodeRequestOwner,
  viewer: CodePageViewerAuthority,
  locale: string,
  readOwner: () => ReturnType<typeof readCodeOwner>,
): Promise<CodePageOwner> {
  if (owner.kind === "person") {
    const name = codePageOwnerPersonName(viewer, owner.name);
    return name ? { kind: "person", name: clip(name) } : { kind: "unavailable" };
  }
  const title = await codeOwnerKindTitle(owner, locale);
  if (!title) return { kind: "unavailable" };
  if (owner.kind === "app") return { kind: "app", name: clip(title) };
  try {
    // The resource's own reader under the viewer's rights; whoever may not see it gets only its type.
    const read = await readOwner();
    return { kind: "resource", type: clip(title), name: read?.title ? clip(read.title) : null };
  } catch (error) {
    if (error instanceof CodeOwnerUnavailableError) return { kind: "unavailable" };
    throw error;
  }
}

async function cardAutomation(code: Code, versionId: string, owner: CodePageOwner, authority: RequestAuthority, locale: string) {
  const [row] = await sql<{ number: number; created_at: Date; active_since: Date | null; approved_by: string | null }[]>`
    SELECT v.number,v.created_at,a.updated_at AS active_since,COALESCE(NULLIF(u.display_name,''),u.uid) AS approved_by
    FROM code.versions v
    LEFT JOIN LATERAL (SELECT updated_at FROM code.activations
      WHERE code_id=v.code_id AND version_id=v.id AND state='active' ORDER BY updated_at DESC LIMIT 1) a ON true
    LEFT JOIN code.version_decisions d ON d.version_id=v.id AND d.outcome='approved'
    LEFT JOIN auth.users u ON u.id=d.decided_by
    WHERE v.id=${versionId}::uuid AND v.code_id=${code.id}`;
  if (!row) throw new CodePageChangedError();
  return {
    title: clip(code.title),
    version: row.number,
    // Versions switched on before activations were recorded have no row; they run at least since they exist.
    activeSince: (row.active_since ?? row.created_at).toISOString(),
    approvedBy: row.approved_by ? clip(row.approved_by) : null,
    href: await automationHref(code, owner, authority, locale),
  };
}

/**
 * The automation's Code page for this viewer: the page its owner's app declares for a resource the viewer may see
 * (`code.pages`), otherwise Core's Code page, which every Code has and which checks the viewer's rights itself.
 */
async function automationHref(code: Code, owner: CodePageOwner, authority: RequestAuthority, locale: string): Promise<string> {
  const own = `/app/assistant/code/${code.id}`;
  if (code.owner.kind !== "resource" || owner.kind !== "resource" || !owner.name) return own;
  const { ref } = code.owner;
  const appId = cloudResourceRefAppId(ref);
  const app = await getCapabilityCatalogApp(appId, locale, authority);
  const pattern = app.ok ? app.data?.manifest.code?.pages?.[ref.type.slice(appId.length + 1)] : undefined;
  return pattern ? pattern.replace("{id}", encodeURIComponent(ref.id)) : own;
}
