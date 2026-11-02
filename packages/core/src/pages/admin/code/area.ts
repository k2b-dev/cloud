import type { CodeAdminCodeStatus } from "../../../code/admin";
import { CODE_POLICY_ROWS, type CodePolicyRow } from "../../../code/policy-contracts";

/** Sections of Administration › Code; each one is a row in the area column. */
export const CODE_AREA_SECTIONS = [
  "approvals",
  "code",
  "policy",
  "groups",
  "effective",
  "history",
  "cleanup",
  "limits",
  "runners",
] as const;
export type CodeAreaSection = (typeof CODE_AREA_SECTIONS)[number];
const STATUSES = ["active", "paused", "draft", "deleting", "waiting"] as const satisfies readonly CodeAdminCodeStatus[];

/** The selection the URL holds, so reload, back and links return to the same place. */
export type CodeAreaQuery = {
  sec?: CodeAreaSection;
  /** Version UUID in approvals, Code ID in code, group UUID in groups, person UUID in effective. */
  id?: string;
  /** Version UUID whose source the Code detail shows, read-only. */
  version?: string;
  /** `decided` shows decided versions in approvals. */
  tab?: "decided";
  status?: CodeAdminCodeStatus;
  app?: string;
  q?: string;
  /** Opaque list cursor for the next page of approvals, all Code or cleanup. */
  after?: string;
};

export const CODE_AREA_PATH = "/admin/code";

export const codeAreaHref = (query: CodeAreaQuery): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  const search = params.toString();
  return search ? `${CODE_AREA_PATH}?${search}` : CODE_AREA_PATH;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_ID = /^c_[a-z0-9]{4,16}$/;
const APP = /^[a-z][a-z0-9-]{0,79}$/;
const APPROVAL_AFTER = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[0-9a-f-]{36}$/;
/** Title cursor bound: 200 title code units at most six JSON bytes each (escape or UTF-8), plus the ID, in base64url. */
const CODE_CURSOR_MAX = Math.ceil(((200 * 6 + 64) * 4) / 3);

export const parseCodeAreaQuery = (query: Record<string, string | undefined>): CodeAreaQuery => {
  const sec = CODE_AREA_SECTIONS.find((section) => section === query.sec);
  if (!sec) return {};
  const id = query.id ?? "";
  if (sec === "approvals")
    return {
      sec,
      ...(query.tab === "decided" ? { tab: "decided" as const } : {}),
      ...(UUID.test(id) ? { id } : {}),
      ...(query.tab !== "decided" && query.after && APPROVAL_AFTER.test(query.after) ? { after: query.after } : {}),
    };
  if (sec === "cleanup") return { sec, ...(query.after && UUID.test(query.after) ? { after: query.after } : {}) };
  if (sec === "code") {
    const status = STATUSES.find((value) => value === query.status);
    const q = query.q?.trim().slice(0, 100);
    return {
      sec,
      ...(CODE_ID.test(id) ? { id, ...(UUID.test(query.version ?? "") ? { version: query.version } : {}) } : {}),
      ...(status ? { status } : {}),
      ...(query.app && APP.test(query.app) ? { app: query.app } : {}),
      ...(q ? { q } : {}),
      ...(query.after && query.after.length <= CODE_CURSOR_MAX && /^[\w-]+$/.test(query.after) ? { after: query.after } : {}),
    };
  }
  if (sec === "groups" || sec === "effective") return { sec, ...(UUID.test(id) ? { id } : {}) };
  return { sec };
};

/** The deepest level the selection reaches; the workspace shows it and as many levels before it as fit. */
export const codeAreaLevel = (query: CodeAreaQuery): "area" | "section" | "detail" =>
  query.id ? "detail" : query.sec ? "section" : "area";

/** Sections whose content fills the list and detail columns together. */
export const isWideCodeSection = (section: CodeAreaSection | undefined): boolean =>
  section === "policy" || section === "history" || section === "cleanup" || section === "limits" || section === "runners";

/** Rows grouped as the policy table shows them. */
export const CODE_POLICY_ROW_GROUPS: readonly { key: "grpRead" | "grpSilent" | "grpAsk" | "grpAiNet"; rows: CodePolicyRow[] }[] = [
  { key: "grpRead", rows: ["read"] },
  { key: "grpSilent", rows: CODE_POLICY_ROWS.filter((row) => row.startsWith("silent_")) },
  { key: "grpAsk", rows: CODE_POLICY_ROWS.filter((row) => row.startsWith("ask_")) },
  { key: "grpAiNet", rows: ["ai", "internet"] },
];

/** The capability policy each row stands for, as application authors write it. */
export const codePolicyRowCode = (row: CodePolicyRow): string =>
  row === "read" ? "query" : row === "ai" ? "ai" : row === "internet" ? "http.fetch" : row.replace(/^(silent|ask)_/, "$1: ");

/** Limits shown under Administration › Code › Limits, in this order. */
export const CODE_LIMIT_KEYS = [
  "core.code.wall_clock_ms",
  "core.code.calls_per_run",
  "core.code.calls_per_second",
  "core.code.database_bytes",
  "core.code.ai_budget_usd",
  "core.code.concurrency_per_code",
  "core.code.concurrency_per_owner",
] as const;
