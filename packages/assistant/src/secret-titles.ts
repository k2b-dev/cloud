import type { AiStoredMessage, AiTurnSnapshot } from "@k2b/cloud/ai";
import { buildAiMessageTimeline, CODE_SECRET_ERRORS } from "@k2b/cloud/ai/browser";
import { z } from "zod";
import type { CodeQueryInvoke } from "./code-summary";

/**
 * A title per automation id: the title, `null` when Core says the automation is gone or the reader may no longer read
 * it, absent when Core could not answer.
 */
export type SecretTitles = Record<string, string | null>;

const CodeTitleSchema = z.object({ code: z.object({ title: z.string() }) });

/** The automation of a stored `code_secret` call whose outcome line names it: "not saved" after a lost right. */
export const secretTitleRef = (block: { kind: string; name?: string; args?: unknown; result?: unknown }): string | null => {
  if (block.kind !== "tool" || block.name !== "code_secret") return null;
  const target = typeof block.args === "object" && block.args !== null ? Reflect.get(block.args, "target") : undefined;
  const code = typeof target === "object" && target !== null ? Reflect.get(target, "code") : undefined;
  const error = typeof block.result === "object" && block.result !== null ? Reflect.get(block.result, "error") : undefined;
  return typeof code === "string" && error === CODE_SECRET_ERRORS.accessLost ? code : null;
};

/** The automations of a chat's stored outcome lines, from the same timeline projection the turn renderer uses. */
export function chatSecretTitleRefs(messages: AiStoredMessage[], activeTurn?: AiTurnSnapshot | null): string[] {
  const groups = buildAiMessageTimeline(messages).flatMap((item) => (item.type === "assistant" ? [item.blocks] : []));
  if (activeTurn) groups.push(activeTurn.blocks);
  return [...new Set(groups.flat().flatMap((block) => secretTitleRef(block) ?? []))];
}

/**
 * One loader for the request snapshot and the browser store, with the reader's own rights: a title the reader may not
 * read stays `null`. One query per distinct automation, one after another, and only for lines that name one.
 */
export async function loadSecretTitles(invoke: CodeQueryInvoke, codeIds: readonly string[]): Promise<SecretTitles> {
  const titles: SecretTitles = {};
  for (const codeId of new Set(codeIds)) {
    const answer = await invoke({ appId: "core", capabilityId: "code.read", kind: "query", input: { codeId } }, CodeTitleSchema).catch(
      () => null,
    );
    if (answer?.ok) titles[codeId] = answer.data.data.code.title;
    else if (answer && (answer.error.code === "NOT_FOUND" || answer.error.code === "FORBIDDEN" || answer.error.status === 403))
      titles[codeId] = null;
  }
  return titles;
}
