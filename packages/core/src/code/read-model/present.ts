import type { CodeTestLimits } from "@k2b/cloud/code";
import {
  CODE_READ_MODEL_LIST_LIMIT,
  type CodeCheckedVersionManifest,
  type CodeReadModelChange,
  type CodeReadModelRow,
  type CodeVersionReadModel,
} from "@k2b/cloud/contracts";
import { describeCodeTiming } from "@k2b/cloud/ssr/code-page/schedule";
import type { CodeVersionEvidence } from "../version-evidence";
import { codeReadModelMessages } from "./messages";
import { describeCodeNotices } from "./notices";

export type ReadModelTarget = { name: string; readable: boolean; href?: string; app?: string; icon?: string };
export type ReadModelNames = {
  target: (ref: { type: string; id: string | null }) => ReadModelTarget;
  operation: (id: string) => { title: string; app?: string; icon?: string };
  event: (type: string) => string;
};
export const readModelList = <T>(items: T[], locale: string) => {
  const more = Math.max(0, items.length - CODE_READ_MODEL_LIST_LIMIT);
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
type Fact = { key: string; text: string; note?: string };
function facts(manifest: CodeCheckedVersionManifest, names: ReadModelNames, locale: string): Fact[] {
  const { t } = codeReadModelMessages.resolve([locale]);
  return [
    ...manifest.permissions.map(({ operation, target }) => ({
      key: `permission:${stable({ operation, target })}`,
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
    ...(manifest.internet ?? []).map((origin) => ({ key: `internet:${origin}`, text: t.internet({ origin }) })),
    ...(manifest.secrets ?? []).map((secret) => ({
      key: `secret:${stable(secret)}`,
      text: t.secret({ name: secret.name, origin: secret.origin, path: secret.pathPrefix }),
      note: t.secretNote,
    })),
    ...manifest.entrypoints
      .filter((entry) => entry.route)
      .map((entry) => ({
        key: `page:${stable(entry.route)}`,
        text: `${t.page({ audience: entry.route?.public ? t.public : t.members })} · ${entry.route?.method} ${entry.route?.path}`,
      })),
    ...(manifest.database ? [{ key: "database", text: t.database }] : []),
    ...(manifest.ai ? [{ key: "ai", text: t.ai }] : []),
  ];
}

/** Only checked facts enter this projection. Model titles and explanations are deliberately absent from facts(). */
export function presentCodeVersion(input: {
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
}): CodeVersionReadModel {
  const { t, locale } = codeReadModelMessages.resolve([input.locale]);
  const { manifest, names } = input;
  const allReadable = canReadVersionText(manifest, names);
  const mayDo = [
    ...new Map(
      manifest.permissions.map(({ operation, target }) => {
        const action = names.operation(operation);
        const place = names.target(target ?? { type: "app", id: operation.split(".")[0]! });
        return [
          stable({ operation, target }),
          {
            text: t.mayDo({ action: action.title, target: place.name }),
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
  const rows: CodeReadModelChange[] = [
    ...[...after].map(([key, row]) => ({
      kind: before.has(key) ? ("same" as const) : ("add" as const),
      text: row.text,
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
      text: !input.explanation ? null : allReadable ? input.explanation : t.restricted,
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
        name: allReadable ? example.name : t.restricted,
        modelLabel: t.modelLabel,
        state: example.ok ? "succeeded" : "failed",
        status: example.ok ? t.successful : t.failed,
        sentence: allReadable ? example.sentences[locale.startsWith("de") ? "de" : "en"] : t.restricted,
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
