import { expect, test } from "bun:test";
import { checkSource, checkStyles } from "./approval-card-calls";

const place = "/repo/packages/assistant/src/frontend/Panel.tsx";

test("an approval card takes data and answers, never a look", () => {
  const plain = `<ApprovalCard card={card()} state="open" onConfirm={() => decide(true)} outcome={{ lines: lines(), current: "a" }} />`;
  expect(checkSource(place, plain)).toEqual([]);
  for (const look of ['class="wide"', "style={{ color: 'red' }}", 'variant="compact"', "classList={{ x: true }}", "{...props}"])
    expect(checkSource(place, `const a = 1;\n<ApprovalCard card={card()} ${look} state="open" />`)).toMatchObject([{ line: 2 }]);
  // Props whose values mention a look word are fine; only the names count.
  expect(checkSource(place, `<ApprovalCard card={{ ...card(), style: 1 }} state="open" />`)).toEqual([]);
  expect(checkSource("/repo/packages/x/a.test.tsx", `<ApprovalCard class="x" />`)).toEqual([]);
});

test("Chat.Decision draws only inside ApprovalCard", () => {
  expect(checkSource(place, "<Chat.Decision state='open' />")).toHaveLength(1);
  expect(checkSource("/repo/packages/cloud/src/approvals/ApprovalCard.tsx", "<Chat.Decision state='open' />")).toEqual([]);
  expect(checkSource(place, "type S = ChatDecisionState;")).toEqual([]);
  expect(checkSource("/repo/packages/ui/src/chat/ChatDecision.tsx", "export function ChatDecision() {}")).toEqual([]);
});

test("only the decision card's stylesheets style it", () => {
  expect(checkStyles("app.css", ".k2b-ui .k2b-chat-decision { background: red; }", false)).toHaveLength(1);
  expect(checkStyles("index.css", ".k2b-ui .k2b-chat-decision { background: red; }", true)).toEqual([]);
  expect(checkStyles("app.css", ".k2b-ui .other { color: red; }", false)).toEqual([]);
});
