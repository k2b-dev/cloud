import { expect, test } from "bun:test";
import { type AssistantChoice, assistantChoiceText } from "./choices";

const choice: AssistantChoice = {
  turnId: "Trn234",
  toolCallId: "call-1",
  blockId: "category",
  title: "Welche Kategorie?",
  mode: "one",
  options: [
    { id: "cat_jug", label: "Jugendstil-Vase" },
    { id: "cat_mod", label: "Moderne" },
  ],
};

test.each(["one", "many"] as const)("terminal prints a %s choice with numbered labels, ids, and a browser link", (mode) => {
  expect(assistantChoiceText({ ...choice, mode }, "https://cloud.test/app/assistant?conversation=Chat23")).toBe(
    "Welche Kategorie?\n1. Jugendstil-Vase [cat_jug]\n2. Moderne [cat_mod]\nAnswer in Cloud: https://cloud.test/app/assistant?conversation=Chat23",
  );
});
