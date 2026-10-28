import type { AuditStep, AutomationLogDetail, AutomationLogItem, AutomationLogPage } from "../../contracts";

export type { AuditStep, AutomationLogDetail, AutomationLogItem, AutomationLogPage };
export type AutomationLogFilter = keyof AutomationLogPage["counts"];
export type AutomationLogEffect = AutomationLogItem["effects"][number];
export type AutomationLogReason = AutomationLogItem["reasons"][number];
export type AutomationLogTarget = Extract<AutomationLogEffect, { kind: "assign" }>["target"];
