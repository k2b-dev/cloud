import type { CodeCheckDiagnostic, CodeTestResult } from "@k2b/cloud/code";
import { CODE_READ_MODEL_LIST_LIMIT, type CodeReadModelExample, type CodeReadModelNotice } from "@k2b/cloud/contracts";
import { codeVersionEvidence } from "../version-evidence";
import { codeReadModelMessages } from "./messages";
import { describeCodeNotices } from "./notices";
import { describeExpectedValue } from "./present";

/** What the chat shows of one Code step: Cloud's sentences, never source, files, lines, codes or IDs. */
export type CodeChatStepWords = {
  notices: CodeReadModelNotice[];
  mayDo?: { text: string; isNew: boolean }[];
  examples?: { passed: number; total: number; summary: string; explanation: string; items: CodeReadModelExample[] };
};

const firstLocale = (locale: string | undefined) => codeReadModelMessages.resolve(locale ? [locale] : []).locale;

/** Checker findings as one sentence and its consequence each; warnings after the blocking ones. */
export function describeCodeCheckWords(
  input: {
    diagnostics: readonly Pick<CodeCheckDiagnostic, "code">[];
    warnings: readonly Pick<CodeCheckDiagnostic, "code">[];
    permissions: readonly { title: string | null; typeTitle: string | null; status: "new" | "existing" }[];
  },
  locale: string | undefined,
): CodeChatStepWords {
  const resolved = firstLocale(locale);
  const { t } = codeReadModelMessages.resolve([resolved]);
  const notices = describeCodeNotices([...input.diagnostics, ...input.warnings], resolved);
  const seen = new Set<string>();
  const mayDo = input.permissions.flatMap((permission) => {
    const text = permission.title ?? t.action;
    const where = permission.typeTitle;
    const line = where ? `${text} · ${where}` : text;
    if (seen.has(line)) return [];
    seen.add(line);
    return [{ text: line, isNew: permission.status === "new" }];
  });
  return {
    notices: notices.slice(0, CODE_READ_MODEL_LIST_LIMIT),
    mayDo: mayDo.slice(0, CODE_READ_MODEL_LIST_LIMIT),
  };
}

/**
 * Tried examples in words: the name Gustav gave each one, its result word, and what it did as counted observations.
 * A failed example names what differed in plain words; a run that did not get to its examples says why as a notice.
 */
export function describeCodeTestWords(
  result: CodeTestResult,
  locale: string | undefined,
  operationTitle?: (id: string, locale: string) => string,
): CodeChatStepWords {
  const resolved = firstLocale(locale);
  const { t } = codeReadModelMessages.resolve([resolved]);
  const evidence = codeVersionEvidence(result, operationTitle);
  const items = (evidence.examples ?? []).slice(0, CODE_READ_MODEL_LIST_LIMIT).map(
    (example): CodeReadModelExample => ({
      name: example.name,
      modelLabel: t.modelLabel,
      state: example.ok ? "succeeded" : "failed",
      status: example.ok ? t.successful : t.failed,
      sentence: example.ok || !example.differences?.length ? example.sentences[resolved === "de" ? "de" : "en"] : t.mismatch,
      differences: (example.differences ?? []).map((difference) => ({
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
        expected: describeExpectedValue(difference.expected, resolved),
        actual: describeExpectedValue(difference.actual, resolved),
      })),
    }),
  );
  const passed = items.filter((item) => item.state === "succeeded").length;
  return {
    notices: describeCodeNotices(result.diagnostics, resolved).slice(0, CODE_READ_MODEL_LIST_LIMIT),
    ...(items.length
      ? {
          examples: {
            passed,
            total: items.length,
            summary: t.exampleSummary({ passed, total: items.length }),
            explanation: t.exampleExplanation,
            items,
          },
        }
      : {}),
  };
}
