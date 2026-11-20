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
  // A brace in a string never hides a later look prop; a comment's apostrophe is no string.
  expect(checkSource(place, `<ApprovalCard card={card()}\n  // the card's look\n  state="open" />`)).toEqual([]);
  expect(checkSource(place, `<ApprovalCard label="{" class="wide" state="open" />`)).toMatchObject([{ line: 1 }]);
  expect(checkSource("/repo/packages/x/a.test.tsx", `<ApprovalCard class="x" />`)).toEqual([]);
});

test("the approval frame a Code version or an admin review fills takes data and answers, never a look", () => {
  const plain = `<ApprovalFrame locale="de" state="open" source={source} sentence={sentence()} reason={reason()} confirm={confirm} />`;
  expect(checkSource(place, plain)).toEqual([]);
  for (const look of ['class="wide"', "style={{ color: 'red' }}", 'variant="compact"', 'tone="blue"', "{...props}"])
    expect(checkSource(place, `const a = 1;\n<ApprovalFrame locale="de" ${look} state="open" />`)).toMatchObject([
      { line: 2, message: expect.stringContaining("ApprovalFrame takes no look props") },
    ]);
});

test("Chat.Decision draws only inside ApprovalFrame", () => {
  expect(checkSource(place, "<Chat.Decision state='open' />")).toHaveLength(1);
  expect(checkSource("/repo/packages/cloud/src/approvals/ApprovalCard.tsx", "<Chat.Decision state='open' />")).toHaveLength(1);
  expect(checkSource("/repo/packages/cloud/src/approvals/ApprovalFrame.tsx", "<Chat.Decision state='open' />")).toEqual([]);
  // A question that asks for one value is no approval.
  expect(checkSource(place, "<Chat.Decision state='open' entry={<ChatDecisionField label='Value' />} />")).toEqual([]);
  expect(checkSource(place, "<Chat.Decision state='open' entry={<Other />} />")).toHaveLength(1);
  // Only the tag's own `entry` prop counts, not a field in another prop or a nested element's `entry`.
  expect(checkSource(place, "<Chat.Decision state='open' sentence={<ChatDecisionField label='Value' />} />")).toHaveLength(1);
  expect(checkSource(place, "<Chat.Decision sentence={<Other entry={<ChatDecisionField />} />} state='open' />")).toHaveLength(1);
  expect(checkSource(place, "<Chat.Decision state='open' myentry={<ChatDecisionField />} />")).toHaveLength(1);
  // A brace inside a string neither ends the tag nor lets a later field count for it.
  expect(checkSource(place, '<Chat.Decision state="open" label="{" />\n<ChatDecisionField label="Value" />')).toHaveLength(1);
  expect(checkSource(place, "<Chat.Decision state='open' label={'{'} />\nconst entry = <ChatDecisionField />;")).toHaveLength(1);
  expect(checkSource(place, '<Chat.Decision state="open" label="}>" entry={<ChatDecisionField label={"}"} />} />')).toEqual([]);
  expect(checkSource(place, "<Chat.Decision state='open' label=\"x\" entry={\n  <ChatDecisionField label={`a ${b}`} />\n} />")).toEqual([]);
  // Comments between props are no code, even with an apostrophe or a brace in them.
  expect(checkSource(place, "<Chat.Decision state='open'\n  // the card's field {\n  entry={<ChatDecisionField />} />")).toEqual([]);
  expect(checkSource(place, "<Chat.Decision state='open' /* entry={<ChatDecisionField />} */ />")).toHaveLength(1);
  // A tag that never ends fails closed.
  expect(checkSource(place, "<Chat.Decision state='open' label=\"x entry={<ChatDecisionField />} />")).toHaveLength(1);
  expect(checkSource(place, "type S = ChatDecisionState;")).toEqual([]);
  expect(checkSource(place, 'import { Chat as C } from "@k2b/ui";\n<C.Decision state="open" />')).toHaveLength(1);
  expect(checkSource(place, 'import { ChatDecision as D } from "@k2b/ui";\n<D state="open" />')).not.toHaveLength(0);
  expect(checkSource("/repo/packages/ui/src/chat/ChatDecision.tsx", "export function ChatDecision() {}")).toEqual([]);
});

test("only the decision card's stylesheets style it", () => {
  expect(checkStyles("app.css", ".k2b-ui .k2b-chat-decision { background: red; }", false)).toHaveLength(1);
  expect(checkStyles("index.css", ".k2b-ui .k2b-chat-decision { background: red; }", true)).toEqual([]);
  expect(checkStyles("app.css", ".k2b-ui .other { color: red; }", false)).toEqual([]);
});
