import type { AiStoredMessage, AiTurnSnapshot } from "@k2b/cloud/ai";
import { buildAiMessageTimeline } from "@k2b/cloud/ai/browser";
import { CODE_VERSION_CARD_BATCH_LIMIT, type CodeVersionCards, codeVersionCardsContract } from "@k2b/cloud/contracts/code-version-cards";
import type { CodeQueryInvoke } from "./code-summary";

export type CodeVersionCardRef = { codeId: string; versionId: string };
export type CodeVersionCardEntry = CodeVersionCards["items"][number] | (CodeVersionCardRef & { state: "failed" });
export const codeVersionCardKey = (ref: CodeVersionCardRef) => `${ref.codeId}:${ref.versionId}`;

/** Same public protocol projection as the turn renderer. Transcript references grant no access to the returned data. */
export function chatCodeVersionRefs(messages: AiStoredMessage[], activeTurn?: AiTurnSnapshot | null): CodeVersionCardRef[] {
  const refs = new Map<string, CodeVersionCardRef>();
  const groups = buildAiMessageTimeline(messages).flatMap((item) => (item.type === "assistant" ? [item.blocks] : []));
  if (activeTurn) groups.push(activeTurn.blocks);
  for (const blocks of groups) {
    const displayed = new Map<string, CodeVersionCardRef>();
    for (const block of blocks) {
      if (block.kind !== "tool" || block.name !== "code_submit" || block.status !== "completed" || block.isError) continue;
      const parsed = codeVersionCardsContract.input.shape.versions.element.safeParse({
        codeId: typeof block.args === "object" && block.args !== null && "codeId" in block.args ? block.args.codeId : null,
        versionId:
          typeof block.result === "object" &&
          block.result !== null &&
          "submission" in block.result &&
          typeof block.result.submission === "object" &&
          block.result.submission !== null &&
          "version" in block.result.submission &&
          typeof block.result.submission.version === "object" &&
          block.result.submission.version !== null &&
          "number" in block.result.submission.version &&
          typeof block.result.submission.version.number === "number" &&
          "id" in block.result.submission.version
            ? block.result.submission.version.id
            : null,
      });
      if (parsed.success) displayed.set(parsed.data.codeId, parsed.data);
    }
    // The timeline replaces an earlier submit of the same Code within a turn with the latest successful one.
    for (const ref of displayed.values()) refs.set(codeVersionCardKey(ref), ref);
  }
  return [...refs.values()];
}

/** One loader for the request snapshot and the browser store. No Core source imports or detail reads. */
export async function loadCodeVersionCards(
  invoke: CodeQueryInvoke,
  refs: readonly CodeVersionCardRef[],
  knownPages: readonly string[] = [],
): Promise<CodeVersionCardEntry[]> {
  const unique = [...new Map(refs.map((ref) => [codeVersionCardKey(ref), ref])).values()];
  const items: CodeVersionCardEntry[] = [];
  for (let start = 0; start < unique.length; start += CODE_VERSION_CARD_BATCH_LIMIT) {
    const versions = unique.slice(start, start + CODE_VERSION_CARD_BATCH_LIMIT);
    const known = new Set(versions.map((ref) => ref.versionId));
    const answer = await invoke(
      {
        appId: "core",
        capabilityId: "code.version.cards",
        kind: "query",
        input: { versions, knownPages: knownPages.filter((id) => known.has(id)) },
      },
      codeVersionCardsContract.data,
    ).catch(() => null);
    const returned = answer?.ok ? new Map(answer.data.data.items.map((item) => [codeVersionCardKey(item), item])) : null;
    for (const ref of versions) items.push(returned?.get(codeVersionCardKey(ref)) ?? { ...ref, state: "failed" });
  }
  return items;
}
