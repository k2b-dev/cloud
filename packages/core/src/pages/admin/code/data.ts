import type { DateContext } from "@k2b/stdlib";
import type { NavProps } from "@k2b/ui/v2";
import type {
  CodeAdminApproval,
  CodeAdminApprovalDetail,
  CodeAdminCode,
  CodeAdminCodeDetail,
  CodeAdminDecided,
  CodeAdminEffective,
  CodeAdminPolicy,
  CodeAdminPolicyChange,
  CodeAdminSummary,
} from "../../../code/admin";
import type { CodeOwner } from "../../../code/contracts";
import type { UnusedCodeDatabase } from "../../../code/database-retention";
import type { CodeCleanupJob } from "../../../code/lifecycle-contracts";
import type { CodePageReportPage } from "../../../code/page-report-contracts";
import type { CodeRunnerMetrics } from "../../../code/scheduling-contracts";
import type { SettingFieldDef } from "../settings/_components/setting-field";
import type { CodeAreaQuery } from "./area";
import type { CodeAdminMessages } from "./messages";
import type { CodeReviewMessages } from "./review-messages";

/** A part of the page: its data, a failed load, a selection that no longer exists, or not needed for this URL. */
export type Loaded<T> = T | "failed" | "missing" | null;
export type CodeAreaData = {
  summary: Loaded<CodeAdminSummary>;
  approvals: Loaded<{ items: CodeAdminApproval[]; nextCursor: string | null }>;
  decided: Loaded<CodeAdminDecided[]>;
  approval: Loaded<CodeAdminApprovalDetail>;
  codes: Loaded<{ items: CodeAdminCode[]; total: number; owners: number; nextCursor: string | null }>;
  code: Loaded<CodeAdminCodeDetail>;
  /** Open reports on the selected automation's pages. */
  reports?: Loaded<CodePageReportPage>;
  policy: Loaded<CodeAdminPolicy>;
  effective: Loaded<CodeAdminEffective>;
  history: Loaded<{ items: CodeAdminPolicyChange[]; nextPage: number | null }>;
  databases?: Loaded<{ items: UnusedCodeDatabase[]; nextCursor: string | null }>;
  cleanup: Loaded<{ items: CodeCleanupJob[]; nextCursor: string | null }>;
  runners: Loaded<CodeRunnerMetrics>;
  limits: Loaded<SettingFieldDef[]>;
};

export const ok = <T>(value: Loaded<T> | undefined): value is T =>
  value !== null && value !== undefined && value !== "failed" && value !== "missing";

/** An app of this Cloud as the Code area shows it: its name and its data colour. */
export type CodeApp = { name: string; color?: string };

/** What every Code screen gets from the server beside its own data. */
export type CodeScreenBase = {
  /** The admin bar with the Code sections, built by the server. */
  nav: NavProps;
  query: CodeAreaQuery;
  dateConfig: DateContext;
  /** The reading admin, for "You" and for deleting own comments. */
  viewerId: string;
  /** The apps of this Cloud by ID. */
  apps: Record<string, CodeApp>;
  /** The documentation article of the section, when the Cloud names a documentation website. */
  documentationHref?: string;
};

/** The colour of Code itself (the new commit of the feat/code sign), for personal automations. */
export const CODE_COLOR = "#16a34a";

/** The app an owner belongs to: its own app, the app of its place, or none for a person. */
export const ownerAppId = (owner: CodeOwner): string | null =>
  owner.kind === "app" ? owner.appId : owner.kind === "resource" ? (owner.ref.type.split(".")[0] ?? null) : null;

export function ownerLabel(t: CodeAdminMessages, owner: CodeOwner, ownerName: string | null, apps: Record<string, CodeApp>): string {
  if (owner.kind === "person") return t.ownerPerson({ who: ownerName ?? t.unknownAuthor });
  if (owner.kind === "app") return t.ownerApp({ app: apps[owner.appId]?.name ?? owner.appId });
  const appId = ownerAppId(owner) ?? "";
  // The place's own name when its reader let this admin read it; otherwise only its kind, never its identifier.
  return ownerName ?? t.ownerHidden({ app: apps[appId]?.name ?? t.ownerUnknown });
}

/** The mark of an automation: the Code sign in the colour of the app it belongs to; personal Code in Code's own colour. */
export const automationMark = (owner: CodeOwner, apps: Record<string, CodeApp>) => {
  const appId = ownerAppId(owner);
  return { icon: "code", color: (appId ? apps[appId]?.color : undefined) ?? CODE_COLOR };
};

/** Why an admin is asked, in words: what the strictest rows let it do, and which policy says so. */
export function approvalReason(r: CodeReviewMessages, detail: CodeAdminApprovalDetail): string {
  if (!detail.why.length) return r.reasonNone;
  const rows = [...new Set(detail.why.map((row) => r.rowReason({ row: row.row })))].join(" ");
  const groups = [...new Set(detail.why.flatMap((row) => (row.source === "default" ? [] : row.groups)))];
  return r.reason({ rows, policy: groups.length ? r.policyGroups({ groups: groups.join(", ") }) : r.policyDefault });
}

export const statusText = (t: CodeAdminMessages, code: Pick<CodeAdminCode, "status" | "pauseReason">) =>
  code.status === "paused" && code.pauseReason === "policy_changed"
    ? t.pausedPolicy
    : code.status === "paused" && code.pauseReason === "owner_not_found"
      ? t.pausedOwner
      : t.statusLabel({ s: code.status });
