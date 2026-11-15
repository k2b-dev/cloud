import { z } from "zod";
import { codeReadModelMessages } from "./messages";
import type { ReadModelNames } from "./present";

// A snapshot contains app-owned templates and exact references, never input/response prose or names.
const storedText = z
  .string()
  .refine((value) => !/[\u0000]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value));
const ref = z.strictObject({ type: storedText, id: storedText });
const form = z.strictObject({ text: storedText.max(200), kind: storedText.min(1).max(80), targetType: storedText });
export const CodeEffectEvidenceSchema = z.strictObject({
  forms: z.strictObject({ de: form.optional(), en: form.optional() }),
  refs: z.array(ref).max(50),
});
export type CodeEffectEvidence = z.infer<typeof CodeEffectEvidenceSchema>;

export function effectTarget(evidence: unknown, locale: string, target: { type: string; id: string } | null) {
  const parsed = CodeEffectEvidenceSchema.safeParse(evidence);
  const result = parsed.success ? parsed.data.forms[locale.startsWith("de") ? "de" : "en"] : undefined;
  if (!result || /[{}]/.test(result.text.replace("{target}", ""))) return null;
  const refs = [...(parsed.success ? parsed.data.refs : []), ...(target ? [target] : [])];
  const matches = new Map(refs.filter((ref) => ref.type === result.targetType).map((ref) => [ref.id, ref]));
  return matches.size === 1 ? { form: result.text, kind: result.kind, ref: [...matches.values()][0]! } : null;
}

export function presentEffect(
  input: { operation: string; evidence: unknown; target: { type: string; id: string } | null; count?: number },
  names: ReadModelNames,
  locale: string,
) {
  const { t } = codeReadModelMessages.resolve([locale]);
  const operation = names.operation(input.operation);
  const effect = effectTarget(input.evidence, locale, input.target);
  const target = effect ? names.target(effect.ref) : null;
  return {
    text:
      effect && target
        ? effect.form
            .replace("{target}", () => (target.readable ? `${effect.kind} ${t.namedTarget({ name: target.name })}` : effect.kind))
            .replace(/\s+/g, " ")
            .trim()
        : t.times({ action: operation.title, count: input.count ?? 1 }),
    ...(operation.app ? { app: operation.app } : {}),
    ...(operation.icon ? { icon: operation.icon } : {}),
    ...(target?.readable && target.href ? { href: target.href } : {}),
    state: "succeeded" as const,
  };
}
