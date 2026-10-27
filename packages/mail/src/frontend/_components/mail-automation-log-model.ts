// The Protokoll contract as the UI reads it. TODO(S4a): import these from ../../contracts once the API lands.

export type AutomationLogFilter = "all" | "assignments" | "uncertain" | "skipped" | "manual";
export type AutomationLogTarget = { kind: "user" | "group"; id: string; name: string };
export type AutomationLogEffect =
  | { kind: "assign"; target: AutomationLogTarget }
  | { kind: "unassign" }
  | { kind: "tag"; name: string }
  | { kind: "move"; folder: string }
  | { kind: "archive" }
  | { kind: "status"; status: "needs_action" | "waiting" | "done" }
  | { kind: "read" }
  | { kind: "comment" }
  | { kind: "summary" };
export type AutomationLogReason =
  | { kind: "ai_choice"; value: string; choices: string[] }
  | { kind: "ai_value"; field: string; value: string | number | boolean; evidence: string | null }
  | { kind: "comparison"; text: string; met: boolean }
  | { kind: "no_target"; choice: string }
  | { kind: "condition"; text: string }
  | { kind: "skipped_upper_rule"; workflowId: string; name: string }
  | { kind: "already_assigned" }
  | { kind: "undone_before" }
  | {
      kind: "manual";
      before: { kind: "user" | "group"; name: string; byRule: string | null } | null;
      after: { kind: "user" | "group"; name: string } | null;
    };

export type AutomationLogItem = {
  id: string;
  at: string;
  conversation: { id: string; subject: string; from: { name: string | null; email: string }; href: string };
  by:
    | { kind: "rule"; workflowId: string; name: string; position: number; version: number; ai: boolean; href: string }
    | { kind: "person"; userId: string; name: string };
  outcome: "assigned" | "uncertain" | "nobody" | "skipped" | "effects" | "manual_change" | "failed";
  effects: AutomationLogEffect[];
  reasons: AutomationLogReason[];
  undo: {
    state: "available" | "done" | "not_possible" | "none";
    reason: "changed_by_person" | "conversation_gone" | null;
    by: { userId: string; name: string } | null;
    at?: string | null;
  };
};

export type AuditStep =
  | { kind: "rule_start"; name: string; version: number; position: number; preconditions: string[] }
  | { kind: "ai_choice"; value: string; choices: string[] }
  | { kind: "ai_value"; field: string; value: string | number | boolean; evidence: string | null }
  | { kind: "fixed_row"; text: string; target: { kind: "user" | "group"; name: string } | null }
  | { kind: "result"; effects: AutomationLogEffect[]; unchanged: string[] };

export type AutomationLogDetail = AutomationLogItem & {
  chain: AuditStep[];
  aiCalls: { run: number; today: number; limit: number | null };
};

export type AutomationLogPage = {
  day: string;
  counts: Record<AutomationLogFilter, number>;
  items: AutomationLogItem[];
  nextCursor: string | null;
};
