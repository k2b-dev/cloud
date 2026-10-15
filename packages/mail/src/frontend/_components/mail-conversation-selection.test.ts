import { describe, expect, test } from "bun:test";
import {
  emptyMailConversationSelection,
  findMailFocusAfterRemoval,
  MAX_MAIL_CONVERSATION_SELECTION,
  pruneMailConversationSelection,
  toggleMailConversationSelection,
} from "./mail-conversation-selection";

describe("Mail conversation selection", () => {
  const ids = Array.from({ length: 100 }, (_, index) => `conversation-${index}`);

  test("keeps single selection and range selection independent from the active reader", () => {
    const first = toggleMailConversationSelection({
      selection: emptyMailConversationSelection(),
      conversationId: ids[2]!,
      orderedConversationIds: ids,
      range: false,
    });
    const ranged = toggleMailConversationSelection({
      selection: first,
      conversationId: ids[5]!,
      orderedConversationIds: ids,
      range: true,
    });
    expect([...ranged.ids]).toEqual(ids.slice(2, 6));
    expect(ranged.anchorId).toBe(ids[2]!);
  });

  test("caps shift ranges", () => {
    const started = toggleMailConversationSelection({
      selection: emptyMailConversationSelection(),
      conversationId: ids[0]!,
      orderedConversationIds: ids,
      range: false,
    });
    const before = performance.now();
    const ranged = toggleMailConversationSelection({
      selection: started,
      conversationId: ids.at(-1)!,
      orderedConversationIds: ids,
      range: true,
    });
    expect(ranged.ids.size).toBe(MAX_MAIL_CONVERSATION_SELECTION);
    expect(performance.now() - before).toBeLessThan(100);
  });

  test("prunes filtered conversations and restores focus to the nearest survivor", () => {
    const selection = ids.slice(0, 4).reduce(
      (current, conversationId) =>
        toggleMailConversationSelection({
          selection: current,
          conversationId,
          orderedConversationIds: ids,
          range: false,
        }),
      emptyMailConversationSelection(),
    );
    const pruned = pruneMailConversationSelection(selection, new Set([ids[1]!, ids[3]!]));
    expect([...pruned.ids]).toEqual([ids[1]!, ids[3]!]);
    expect(
      findMailFocusAfterRemoval({
        orderedRowKeys: ids.slice(0, 5),
        activeRowKey: ids[2]!,
        removedRowKeys: new Set([ids[2]!, ids[3]!]),
      }),
    ).toBe(ids[4]!);
  });
});
