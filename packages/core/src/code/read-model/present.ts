import { CODE_BOUND_CHAT_ID, type CodeTestLimits } from "@k2b/cloud/code";
import { describeCodeTiming } from "@k2b/cloud/code/schedule";
import {
  CODE_READ_MODEL_LIST_LIMIT,
  type CodeCheckedVersionManifest,
  type CodeReadModelChange,
  type CodeReadModelRow,
  type CodeVersionReadModel,
} from "@k2b/cloud/contracts";
import { codeUsesBoundChat } from "../bound-chat";
import { codeAdminPermissionChanges } from "../permission-changes";
import { type CodePolicyRow, type CodePolicyValue, isCodeAiOperation } from "../policy-contracts";
import type { CodeVersionEvidence } from "../version-evidence";
import { approvalReason } from "./approval";
import { codeReadModelMessages } from "./messages";
import { describeCodeNotices } from "./notices";

export type ReadModelTarget = { name: string; readable: boolean; unavailable?: boolean; href?: string; app?: string; icon?: string };
export type ReadModelNames = {
  target: (ref: { type: string; id: string | null }) => ReadModelTarget;
  operation: (id: string) => { title: string; app?: string; icon?: string; policyRow?: CodePolicyRow; accessLabel?: string };
  event: (type: string) => string;
};
export const readModelList = <T>(items: T[], locale: string, omitted = 0) => {
  const more = omitted + Math.max(0, items.length - CODE_READ_MODEL_LIST_LIMIT);
  return {
    items: items.slice(0, CODE_READ_MODEL_LIST_LIMIT),
    more,
    moreText: more ? codeReadModelMessages.resolve([locale]).t.more({ count: more }) : null,
  };
};
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return JSON.stringify(value.map(stable));
  if (value && typeof value === "object")
    return JSON.stringify(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  return JSON.stringify(value);
};
export function describeReadModelTiming(
  entry: CodeCheckedVersionManifest["entrypoints"][number],
  names: ReadModelNames,
  locale: string,
): string {
  const { t } = codeReadModelMessages.resolve([locale]);
  if (entry.event) return t.eventTiming({ event: names.event(entry.event.type), place: names.target(entry.event.place).name });
  if (entry.route) return t.route({ audience: entry.route.public ? t.public : t.members });
  if (entry.kind === "manual") return t.manual;
  const timing = describeCodeTiming(entry, locale);
  return timing && timing !== entry.cron ? timing : t.schedule;
}
type Fact = { key: string; text: string; note?: string; policyRow?: CodePolicyRow; accessLabel?: string };
function facts(manifest: CodeCheckedVersionManifest, names: ReadModelNames, locale: string): Fact[] {
  const { t } = codeReadModelMessages.resolve([locale]);
  return [
    ...manifest.permissions.map(({ operation, target }) => ({
      key: `permission:${stable({ operation, target })}`,
      policyRow: names.operation(operation).policyRow,
      accessLabel: names.operation(operation).title,
      text: t.mayDo({
        action: names.operation(operation).title,
        target: names.target(target ?? { type: "app", id: operation.split(".")[0]! }).name,
      }),
    })),
    ...manifest.entrypoints
      .filter((entry) => !entry.route)
      .map((entry) => ({
        key: `trigger:${stable({ kind: entry.kind, event: entry.event, cron: entry.cron, at: entry.at, timeZone: entry.timeZone })}`,
        text: describeReadModelTiming(entry, names, locale),
      })),
    ...(manifest.internet ?? []).map((origin) => ({
      key: `internet:${origin}`,
      policyRow: "internet" as const,
      text: t.internet({ origin }),
    })),
    ...(manifest.secrets ?? []).map((secret) => ({
      key: `secret:${stable(secret)}`,
      policyRow: "internet",
      text: t.secret({ name: secret.name, origin: secret.origin, path: secret.pathPrefix }),
      note: t.secretNote,
    })),
    ...manifest.entrypoints
      .filter((entry) => entry.route)
      .map((entry) => ({
        key: `page:${stable(entry.route)}`,
        ...(entry.route?.public ? { policyRow: "public_routes" as const } : {}),
        text: `${t.page({ audience: entry.route?.public ? t.public : t.members })}${entry.route?.audience === "owner-data" ? ` · ${t.ownerData}` : ""} · ${entry.route?.method} ${entry.route?.path}`,
      })),
    ...(manifest.database ? [{ key: "database", text: t.database }] : []),
    ...(manifest.ai && !manifest.permissions.some((permission) => isCodeAiOperation(permission.operation))
      ? [{ key: "ai", policyRow: "ai" as const, text: t.ai }]
      : []),
  ];
}

/** Only checked facts enter this projection. Model titles and explanations are deliberately absent from facts(). */
export function presentCodeVersion(input: {
  personal: boolean;
  /**
   * Whether the reader is the owner of this personal Code, from comparing the owner's and the reader's ids. Missing
   * means no: only the owner may treat the Code's own chat as a readable target.
   */
  viewerIsOwner?: boolean;
  /** Present only when someone else owns personal Code; null name preserves directory restrictions. */
  runsAs?: { name: string | null };
  versionId: string;
  number: number;
  submittedAt: string;
  manifest: CodeCheckedVersionManifest;
  comparison: CodeCheckedVersionManifest | null;
  comparisonAvailable?: boolean;
  explanation: string | null;
  evidence: CodeVersionEvidence | null;
  names: ReadModelNames;
  locale: string;
  limits: Pick<CodeTestLimits, "cases">;
  policy?: Partial<Record<CodePolicyRow, CodePolicyValue>>;
  boundChat?: { type: string; id: string } | null;
}): CodeVersionReadModel {
  const { t, locale } = codeReadModelMessages.resolve([input.locale]);
  const { manifest, names } = input;
  // Personal Code's own chat (`chat.send` to the bound chat, id null) is no unknown target for its owner: the owner
  // chose it. For anyone else it stays unreadable, so the model's description stays hidden from them.
  const ownChat = (permission: CodeCheckedVersionManifest["permissions"][number]) =>
    input.personal &&
    input.viewerIsOwner === true &&
    permission.operation === "core.ai.chat.send" &&
    permission.target?.type === "core.ai.chat" &&
    permission.target.id === null;
  const checked = { ...manifest, permissions: manifest.permissions.filter((permission) => !ownChat(permission)) };
  const allReadable = canReadVersionText(checked, names);
  const targets = [
    ...checked.permissions.map(({ operation, target }) => target ?? { type: "app", id: operation.split(".")[0]! }),
    ...manifest.entrypoints.flatMap((entry) => (entry.event ? [entry.event.place] : [])),
  ];
  const denied = targets.some((ref) => {
    const target = names.target(ref);
    return !target.readable && !target.unavailable;
  });
  const restrictedText = !denied && targets.some((ref) => names.target(ref).unavailable) ? t.unresolvedDescription : t.restricted;
  const usesBoundChat = codeUsesBoundChat(manifest.permissions);
  const mayDo = [
    ...new Map(
      manifest.permissions.map(({ operation, target }): [string, CodeVersionReadModel["mayDo"]["items"][number]] => {
        const action = names.operation(operation);
        if (input.personal && operation === "core.ai.chat.send" && target?.type === "core.ai.chat" && target.id === null)
          return [
            stable({ operation, target }),
            {
              text: t.chatSend,
              note: input.runsAs ? t.chatSendNoteOther(input.runsAs) : t.chatSendNote,
              // Without a readable bound chat the row still carries the SDK's own handle, so the page finds the chat
              // row and offers its owner to choose one; no reader names that handle, so the safe sentence stays.
              // Code that creates its own chats names none: which one it writes to is decided at run time.
              ...(usesBoundChat
                ? {
                    target: {
                      ref: input.boundChat ?? { type: "core.ai.chat", id: CODE_BOUND_CHAT_ID },
                      text: t.chatSendNamed({ name: "{name}" }),
                    },
                  }
                : {}),
              ...(action.app ? { app: action.app } : {}),
              ...(action.icon ? { icon: action.icon } : {}),
            },
          ];
        const place = names.target(target ?? { type: "app", id: operation.split(".")[0]! });
        const deferredRef =
          place.unavailable && target && target.id !== null && !/[{}]/.test(action.title) ? { type: target.type, id: target.id } : null;
        return [
          stable({ operation, target }),
          {
            text: t.mayDo({ action: action.title, target: place.name }),
            ...(deferredRef ? { target: { ref: deferredRef, text: t.mayDo({ action: action.title, target: "{name}" }) } } : {}),
            ...(action.app ? { app: action.app } : {}),
            ...(action.icon ? { icon: action.icon } : {}),
            ...(place.readable && place.href ? { href: place.href } : {}),
          },
        ];
      }),
    ).values(),
  ];
  const before = new Map((input.comparison ? facts(input.comparison, names, locale) : []).map((row) => [row.key, row]));
  const after = new Map(facts(manifest, names, locale).map((row) => [row.key, row]));
  const addedPermissions = new Set(
    codeAdminPermissionChanges(manifest.permissions, input.comparison?.permissions ?? null)
      .filter((permission) => permission.change === "added")
      .map((permission) => `permission:${stable({ operation: permission.operation, target: permission.target })}`),
  );
  const approvals = new Map<string, { requiresApproval: true; approvalReason: string; accessLabel: string }>();
  for (const [key, fact] of after) {
    if (before.has(key) || !fact.policyRow || input.policy?.[fact.policyRow] !== "admin") continue;
    if (key.startsWith("permission:") && !addedPermissions.has(key)) continue;
    approvals.set(key, {
      requiresApproval: true,
      approvalReason: approvalReason(fact.policyRow, locale),
      accessLabel: fact.accessLabel ?? fact.text,
    });
  }
  const rows: CodeReadModelChange[] = [
    ...[...after].map(([key, row]) => ({
      kind: before.has(key) ? ("same" as const) : ("add" as const),
      text: row.text,
      ...(approvals.get(key) ?? {}),
      ...(row.note ? { note: row.note } : {}),
    })),
    ...[...before]
      .filter(([key]) => !after.has(key))
      .map(([, row]) => ({ kind: "remove" as const, text: row.text, ...(row.note ? { note: row.note } : {}) })),
  ];
  const accessChanged = rows.some((row) => row.kind !== "same");
  const state =
    input.comparisonAvailable === false
      ? "unavailable"
      : !input.comparison
        ? "first"
        : accessChanged
          ? "changed"
          : input.comparison.hashes.bundle !== manifest.hashes.bundle
            ? "access_same_behavior_changed"
            : "same";
  const tests = input.evidence?.tests ?? { state: "none" as const, passed: 0, total: 0 };
  return {
    versionId: input.versionId,
    number: input.number,
    submittedAt: input.submittedAt,
    locale,
    description: {
      state: !input.explanation ? "missing" : allReadable ? "visible" : "restricted",
      text: !input.explanation ? null : allReadable ? input.explanation : restrictedText,
      modelLabel: t.modelLabel,
    },
    assurance: t.assurance,
    mayDo: readModelList(mayDo, locale),
    timing: readModelList(
      manifest.entrypoints.map((entry): CodeReadModelRow => ({ text: describeReadModelTiming(entry, names, locale) })),
      locale,
    ),
    changes: {
      state,
      approval:
        state !== "unavailable" && approvals.size
          ? {
              count: approvals.size,
              reason: [...approvals.values()][0]!.approvalReason,
              accessLabel: approvals.size === 1 ? [...approvals.values()][0]!.accessLabel : null,
              withoutLabel: approvals.size === 1 ? t.withoutAccess({ access: [...approvals.values()][0]!.accessLabel }) : t.withoutApproval,
            }
          : null,
      text:
        state === "access_same_behavior_changed"
          ? t.sameBehavior
          : state === "changed"
            ? t.changed
            : state === "first"
              ? t.first
              : state === "unavailable"
                ? t.unavailable
                : t.same,
      rows: readModelList(state === "unavailable" ? [] : rows, locale),
      assurance: t.changesAssurance,
    },
    examples: {
      state: tests.state,
      passed: tests.passed,
      total: tests.total,
      summary: tests.state === "none" ? t.noExamples : tests.state === "unavailable" ? t.examplesUnavailable : t.exampleSummary(tests),
      explanation: t.exampleExplanation,
      items: (input.evidence?.examples ?? []).slice(0, input.limits.cases).map((example) => ({
        name: allReadable ? example.name : restrictedText,
        modelLabel: t.modelLabel,
        state: example.ok ? "succeeded" : "failed",
        status: example.ok ? t.successful : t.failed,
        sentence: allReadable ? example.sentences[locale.startsWith("de") ? "de" : "en"] : restrictedText,
        differences: allReadable
          ? (example.differences ?? []).map((difference) => ({
              ...(difference.path
                ? {
                    subject:
                      difference.path === "ok"
                        ? t.differenceOk
                        : difference.path === "error"
                          ? t.differenceError
                          : difference.path === "value"
                            ? t.differenceValue
                            : t.differenceCalls,
                  }
                : {}),
              expected: describeExpectedValue(difference.expected, locale),
              actual: describeExpectedValue(difference.actual, locale),
            }))
          : [],
      })),
    },
    notices: readModelList(describeCodeNotices(input.evidence?.notices ?? [], locale), locale),
  };
}

/** Values can contain source, paths, identifiers or private names. Expose scalar facts and types only. */
export function describeExpectedValue(encoded: string, locale: string): string {
  const { t } = codeReadModelMessages.resolve([locale]);
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return t.valueText;
  }
  if (value === null) return t.valueEmpty;
  if (typeof value === "boolean") return value ? t.valueTrue : t.valueFalse;
  if (typeof value === "number" && Number.isFinite(value)) return new Intl.NumberFormat(locale).format(value);
  if (Array.isArray(value)) return `${t.valueList} · ${value.length}`;
  return typeof value === "object" ? t.valueObject : t.valueText;
}

export function canReadVersionText(manifest: CodeCheckedVersionManifest, names: ReadModelNames): boolean {
  return (
    manifest.permissions.every(
      (permission) => names.target(permission.target ?? { type: "app", id: permission.operation.split(".")[0]! }).readable,
    ) && manifest.entrypoints.every((entry) => !entry.event || names.target(entry.event.place).readable)
  );
}
export function restrictVersionEvidence(
  evidence: CodeVersionEvidence | null,
  readable: boolean,
  locale: string,
): CodeVersionEvidence | null {
  if (!evidence || readable || !evidence.examples) return evidence;
  const { t } = codeReadModelMessages.resolve([locale]);
  return {
    ...evidence,
    examples: evidence.examples.map((example) => ({
      name: t.restricted,
      ok: example.ok,
      sentences: { de: codeReadModelMessages.resolve(["de"]).t.restricted, en: codeReadModelMessages.resolve(["en"]).t.restricted },
    })),
  };
}
