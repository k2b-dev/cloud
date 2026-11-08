import { expect, test } from "bun:test";
import {
  type AssistantChoice,
  assistantChoiceForm,
  assistantChoicePrompt,
  assistantChoiceResponse,
  assistantChoiceText,
  parseAssistantChoice,
  submitAssistantChoice,
} from "./choices";

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

test("terminal prints numbered labels and asks in the active locale", () => {
  expect(assistantChoiceText(choice)).toBe("Welche Kategorie?\n1. Jugendstil-Vase [cat_jug]\n2. Moderne [cat_mod]");
  expect(assistantChoicePrompt(choice, "de-DE")).toBe("Wahl (1-2, leer = später): ");
  expect(assistantChoicePrompt(choice, "en")).toBe("Choice (1-2, empty = later): ");
  expect(parseAssistantChoice(choice, "1")).toEqual(["cat_jug"]);
  expect(parseAssistantChoice(choice, " ")).toEqual([]);
  for (const input of ["0", "3", "1,2", "1.5", "-1", "1,1", "cat_jug", "1x"]) expect(parseAssistantChoice(choice, input)).toBeNull();
  expect(parseAssistantChoice({ ...choice, mode: "many" }, "2, 1")).toEqual(["cat_mod", "cat_jug"]);
});

test("ACP forms contain only declared ids, with cancellation and invalid answers leaving the choice open", () => {
  expect(assistantChoiceForm(choice).properties?.ids).toMatchObject({ type: "string", enum: ["cat_jug", "cat_mod"] });
  expect(assistantChoiceForm({ ...choice, mode: "many" }).properties?.ids).toMatchObject({
    type: "array",
    items: { enum: ["cat_jug", "cat_mod"] },
  });
  expect(assistantChoiceResponse(choice, { action: "cancel" })).toBeNull();
  expect(assistantChoiceResponse(choice, { action: "decline" })).toBeNull();
  expect(assistantChoiceResponse(choice, { action: "accept", content: { ids: "missing" } })).toBeNull();
  expect(assistantChoiceResponse(choice, { action: "accept", content: { ids: ["cat_jug", "cat_mod"] } })).toBeNull();
  expect(assistantChoiceResponse(choice, { action: "accept", content: { ids: "cat_jug" } })).toEqual(["cat_jug"]);
});

test("cancellation before submission does not make an HTTP request", async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(
    submitAssistantChoice(
      {
        fetch: async () => {
          throw new Error("Unexpected HTTP request");
        },
        readJson: async () => {
          throw new Error("Unexpected response");
        },
      },
      "Chat23",
      choice,
      ["cat_jug"],
      abort.signal,
    ),
  ).rejects.toThrow();
});

test("terminal submits selected ids through the same choice endpoint", async () => {
  let submitted: { path: string; method?: string; body: unknown } | undefined;
  const result = await submitAssistantChoice(
    {
      fetch: async (path, init) => {
        submitted = { path, method: init?.method, body: JSON.parse(String(init?.body)) };
        return Response.json({ turn: { id: "Turn02" } }, { status: 201 });
      },
      readJson: async (response) => response.json(),
    },
    "Chat23",
    choice,
    ["cat_jug"],
  );
  expect(submitted).toEqual({
    path: "/api/ai/conversations/Chat23/choices",
    method: "POST",
    body: { turnId: "Trn234", toolCallId: "call-1", blockId: "category", ids: ["cat_jug"] },
  });
  expect(result).toEqual({ turn: { id: "Turn02" } });
});
