import type { CodeCheckDiagnostic, CodeTestResult } from "@k2b/cloud/code";
import { CODE_READ_MODEL_LIST_LIMIT, type CodeReadModelExample, type CodeReadModelNotice } from "@k2b/cloud/contracts";
import { i18n } from "@k2b/stdlib";
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

/** The chat's own words around tried examples, as the approved Code chat says them. */
const chatWordMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      explanation:
        "Gustav makes up cases and runs the automation with made-up data. Successful means: it did what Gustav expected for the case. None of it really happens.",
      mismatch: "Differs from what Gustav expected for this example.",
      notRun: "The examples could not run.",
      notRunConsequence: "Nothing about the automation changed; Gustav can try them again.",
    },
    de: {
      explanation:
        "Gustav denkt sich Fälle aus und lässt die Automation mit erfundenen Daten laufen. Erfolgreich heißt: Sie hat getan, was Gustav für den Fall erwartet hat. Nichts davon passiert wirklich.",
      mismatch: "Weicht von dem ab, was Gustav für dieses Beispiel erwartet hat.",
      notRun: "Die Beispiele konnten nicht laufen.",
      notRunConsequence: "An der Automation hat sich nichts geändert; Gustav kann sie noch einmal ausprobieren.",
    },
  },
});

/** Checker findings as one sentence and its consequence each; warnings after the blocking ones. */
export function describeCodeCheckWords(
  input: {
    diagnostics: readonly Pick<CodeCheckDiagnostic, "code">[];
    warnings: readonly Pick<CodeCheckDiagnostic, "code">[];
    permissions: readonly { operation: string; title: string | null; typeTitle: string | null; status: "new" | "existing" }[];
  },
  locale: string | undefined,
  operationTitle?: (id: string) => string | undefined,
): CodeChatStepWords {
  const resolved = firstLocale(locale);
  const { t } = codeReadModelMessages.resolve([resolved]);
  const notices = describeCodeNotices([...input.diagnostics, ...input.warnings], resolved);
  const seen = new Set<string>();
  const mayDo = input.permissions.flatMap((permission) => {
    // What it may do, then where: the target by the name this person may read, else its type. Never an ID.
    const action = operationTitle?.(permission.operation) ?? t.action;
    const where = permission.title ?? permission.typeTitle;
    const line = where ? `${action} · ${where}` : action;
    const isNew = permission.status === "new";
    const key = `${line}\u0000${isNew}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ text: line, isNew }];
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
  const words = chatWordMessages.resolve([resolved]).t;
  const evidence = codeVersionEvidence(result, operationTitle);
  const items = (evidence.examples ?? []).slice(0, CODE_READ_MODEL_LIST_LIMIT).map(
    (example): CodeReadModelExample => ({
      name: example.name,
      modelLabel: t.modelLabel,
      state: example.ok ? "succeeded" : "failed",
      status: example.ok ? t.successful : t.failed,
      sentence: example.ok || !example.differences?.length ? example.sentences[resolved === "de" ? "de" : "en"] : words.mismatch,
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
  const notices = describeCodeNotices(result.diagnostics, resolved);
  // A run that never got to its examples says so, instead of an empty list that reads like "no examples".
  if (!items.length && !result.ok && result.error && !notices.length)
    notices.push({ severity: "warning", text: words.notRun, consequence: words.notRunConsequence });
  return {
    notices: notices.slice(0, CODE_READ_MODEL_LIST_LIMIT),
    ...(items.length
      ? {
          examples: {
            passed,
            total: items.length,
            summary: t.exampleSummary({ passed, total: items.length }),
            explanation: words.explanation,
            items,
          },
        }
      : {}),
  };
}
