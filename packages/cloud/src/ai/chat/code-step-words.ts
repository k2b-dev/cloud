import type { AiTurnBlock } from "../protocol";
import { isRecord } from "./message-utils";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

type Notice = { severity: "warning" | "block"; text: string; consequence: string };
type Example = {
  name: string;
  state: "succeeded" | "failed";
  status: string;
  sentence: string;
  differences: { subject?: string; expected: string; actual: string }[];
};
export type CodeStepWords = {
  notices: Notice[];
  mayDo?: { text: string; isNew: boolean }[];
  examples?: { passed: number; total: number; summary: string; explanation: string; items: Example[] };
};

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Core's words for a finished check, test or simulation; anything else carries none. */
export const codeStepWords = (block: ToolBlock): CodeStepWords | null => {
  if (block.status !== "completed" || !isRecord(block.result) || !isRecord(block.result.words)) return null;
  const words = block.result.words;
  const notices = Array.isArray(words.notices)
    ? words.notices.flatMap((item): Notice[] =>
        isRecord(item) && typeof item.text === "string" && typeof item.consequence === "string"
          ? [{ severity: item.severity === "warning" ? "warning" : "block", text: item.text, consequence: item.consequence }]
          : [],
      )
    : [];
  const mayDo = Array.isArray(words.mayDo)
    ? words.mayDo.flatMap((item) =>
        isRecord(item) && typeof item.text === "string" ? [{ text: item.text, isNew: item.isNew === true }] : [],
      )
    : undefined;
  const examples = isRecord(words.examples) ? words.examples : null;
  const items = Array.isArray(examples?.items)
    ? examples.items.flatMap((item): Example[] =>
        isRecord(item) && typeof item.name === "string" && typeof item.status === "string" && typeof item.sentence === "string"
          ? [
              {
                name: item.name,
                state: item.state === "succeeded" ? "succeeded" : "failed",
                status: item.status,
                sentence: item.sentence,
                differences: Array.isArray(item.differences)
                  ? item.differences.flatMap((difference) =>
                      isRecord(difference) && typeof difference.expected === "string" && typeof difference.actual === "string"
                        ? [{ subject: text(difference.subject) ?? undefined, expected: difference.expected, actual: difference.actual }]
                        : [],
                    )
                  : [],
              },
            ]
          : [],
      )
    : [];
  return {
    notices,
    mayDo,
    examples:
      examples && typeof examples.summary === "string" && typeof examples.explanation === "string" && items.length > 0
        ? {
            passed: typeof examples.passed === "number" ? examples.passed : items.filter((item) => item.state === "succeeded").length,
            total: typeof examples.total === "number" ? examples.total : items.length,
            summary: examples.summary,
            explanation: examples.explanation,
            items,
          }
        : undefined,
  };
};

/** A finished step that has something to show in the conversation itself: notices, or tried examples. */
export const isCodeStepResult = (block: ToolBlock): boolean => {
  if (!["code_check", "code_test", "code_simulate"].includes(block.name)) return false;
  const words = codeStepWords(block);
  return !!words && (words.notices.length > 0 || !!words.examples);
};
