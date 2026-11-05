import type {
  DecisionAnswers,
  DecisionQuestions,
  DecisionRequest,
  DecisionResult,
  SystemOneDecisionOptions,
  TransportReport,
} from "@k2b/nessi/ai";
import { z } from "zod";
import type { TransportObserver } from "./provider-transport";

export type AiDecisionProvider = {
  name: string;
  model: string;
  decide<const TQuestions extends DecisionQuestions>(
    request: DecisionRequest<TQuestions> & TransportObserver,
  ): Promise<DecisionResult<TQuestions>>;
};

const probability = z.number().min(0).max(1);
const responseSchema = z
  .object({
    model: z.string().optional(),
    answers: z.record(z.string(), z.unknown()),
    usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() }).optional(),
  })
  .passthrough();

const parseAnswers = <TQuestions extends DecisionQuestions>(
  questions: TQuestions,
  raw: Record<string, unknown>,
): DecisionAnswers<TQuestions> => {
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = z
      .object({ type: z.literal(question.type) })
      .passthrough()
      .parse(raw[id]);
    if (question.type === "noul") {
      const value = probability.parse(answer.noul);
      answers[id] = { type: "noul", probability: value, value: value >= 0.5 };
      continue;
    }
    const probabilities = z.record(z.string(), z.unknown()).safeParse(answer.probabilities);
    const probabilityOf = (key: string) => {
      const value = probability.safeParse(probabilities.success ? probabilities.data[key] : undefined);
      return value.success ? value.data : 0;
    };
    const confidence = probability.safeParse(answer.confidence);
    if (question.type === "choice") {
      const choice = z
        .string()
        .refine((key) => Object.hasOwn(question.criteria, key))
        .parse(answer.choice);
      answers[id] = {
        type: "choice",
        choice,
        confidence: confidence.success ? confidence.data : probabilityOf(choice),
        probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, probabilityOf(key)])),
      };
    } else {
      if (!probabilities.success && typeof answer.score !== "number") throw new Error("Missing decision score.");
      const values = question.criteria.map((_, level) => probabilityOf(String(level)));
      const expected = values.reduce((sum, value, level) => sum + value * level, 0);
      const score = z
        .number()
        .min(0)
        .max(values.length - 1)
        .parse(typeof answer.score === "number" && Number.isFinite(answer.score) ? answer.score : expected);
      const best = Math.max(...values);
      const level = best > 0 ? values.indexOf(best) : Math.round(score);
      answers[id] = {
        type: "score",
        score,
        level,
        confidence: confidence.success ? confidence.data : values[level],
        probabilities: values,
      };
    }
  }
  // Every requested key and its question-specific answer were validated above.
  return answers as DecisionAnswers<TQuestions>;
};

/** Nessi 1.1.1's decision adapter has no transport hook. Keep this single-request adapter local, without patching global fetch. */
export const systemOneDecisionWithTransport = (model: string, options: SystemOneDecisionOptions): AiDecisionProvider => {
  let base = options.baseURL;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const url = `${base}/systemone`;
  return {
    name: options.name ?? "systemone",
    model,
    async decide({ state, questions, images, signal, onTransport }) {
      signal?.throwIfAborted();
      const body = JSON.stringify({
        model,
        state,
        questions,
        ...(images?.length ? { images: images.map((image) => `data:${image.mediaType};base64,${image.data}`) } : {}),
      });
      let report: TransportReport | undefined;
      try {
        const headers = new Headers(options.headers);
        headers.set("Content-Type", "application/json");
        if (options.apiKey) headers.set("Authorization", `Bearer ${options.apiKey}`);
        report = { startedAt: Date.now() };
        const response = await fetch(url, { method: "POST", headers, body, redirect: "error", signal });
        report.headersAt = Date.now();
        report.status = response.status;
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("Decision provider refused the request.");
        }
        const chunks: Uint8Array[] = [];
        if (response.body) {
          for await (const chunk of response.body) {
            report.firstByteAt ??= Date.now();
            chunks.push(chunk);
          }
        }
        const raw = responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const input = raw.usage?.input_tokens ?? 0;
        const output = raw.usage?.output_tokens ?? 0;
        return {
          model: raw.model ?? model,
          answers: parseAnswers(questions, raw.answers),
          usage: { input, output, total: input + output },
          raw,
        };
      } catch (error) {
        const code = z.object({ code: z.string() }).safeParse(error);
        if (report && report.headersAt === undefined && code.success) report.connectionCode = code.data.code;
        throw error;
      } finally {
        try {
          if (report) onTransport?.(report);
        } catch {
          // Observation cannot change the request outcome, as for Nessi's chat transport.
        }
      }
    },
  };
};
