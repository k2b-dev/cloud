import { prompts } from "@k2b/ui";
import type { PulseSource } from "../../contracts";
import { normalizeEndpointInput, parseScrapeInterval } from "./helpers";
import type { pulseMessages } from "../../messages";
import { usePulseMessages } from "../use-messages";

type SourceEditResult = Record<string, unknown> | null | undefined;
type SourceEditFields = Parameters<typeof prompts.form>[0]["fields"];
type SourceEditField = SourceEditFields[string];

type Messages = ReturnType<typeof pulseMessages.resolve>["t"];

const sourceNameField = (source: PulseSource, t: Messages): SourceEditField => ({
  type: "text",
  label: t.sourceName,
  description: t.sourceNameEditDescription,
  required: true,
  default: source.name,
});

const sourceEditFields = (source: PulseSource, t: Messages): SourceEditFields => {
  const fields: SourceEditFields = { name: sourceNameField(source, t) };
  if (source.kind !== "metrics") return fields;

  return {
    ...fields,
    endpointUrl: {
      type: "text",
      label: t.metricsEndpointUrl,
      description: t.metricsEndpointEditDescription,
      required: true,
      default: source.endpointUrl ?? "",
    },
    scrapeIntervalSeconds: {
      type: "text",
      label: t.scrapeIntervalSeconds,
      description: t.scrapeIntervalEditDescription,
      default: String(source.scrapeIntervalSeconds ?? 60),
    },
    bearerToken: {
      type: "text",
      label: t.newBearerToken,
      description: t.newBearerTokenDescription,
      placeholder: t.leaveUnchanged,
    },
  };
};

const trimDialogString = (value: unknown): string => String(value ?? "").trim();

const sourceNameFromResult = (result: SourceEditResult): string | null => {
  const name = trimDialogString(result?.name);
  return name || null;
};

const endpointFromResult = (source: PulseSource, result: SourceEditResult): string | null => {
  const endpoint = trimDialogString(result?.endpointUrl) || source.endpointUrl?.trim() || "";
  return endpoint || null;
};

const scrapeIntervalFromResult = (source: PulseSource, result: SourceEditResult): number =>
  parseScrapeInterval(String(result?.scrapeIntervalSeconds ?? source.scrapeIntervalSeconds ?? 60));

const bearerTokenFromResult = (result: SourceEditResult): string | null => {
  const bearerToken = trimDialogString(result?.bearerToken);
  return bearerToken || null;
};

const metricsSourcePatchFromResult = (source: PulseSource, result: SourceEditResult): Record<string, unknown> | null => {
  const endpoint = endpointFromResult(source, result);
  if (!endpoint) return null;

  const patch: Record<string, unknown> = {
    endpointUrl: normalizeEndpointInput(endpoint),
    scrapeIntervalSeconds: scrapeIntervalFromResult(source, result),
  };
  const bearerToken = bearerTokenFromResult(result);
  if (bearerToken) patch.bearerToken = bearerToken;
  return patch;
};

const sourcePatchFromResult = (source: PulseSource, result: SourceEditResult): Record<string, unknown> | null => {
  const name = sourceNameFromResult(result);
  if (!name) return null;

  const patch: Record<string, unknown> = { name };
  if (source.kind !== "metrics") return patch;

  const metricsPatch = metricsSourcePatchFromResult(source, result);
  return metricsPatch ? { ...patch, ...metricsPatch } : null;
};

export const openSourceEditDialog = async (source: PulseSource): Promise<Record<string, unknown> | null> => {
  const t = usePulseMessages();
  const result = await prompts.form({
    title: source.kind === "metrics" ? t().editMetricsSource : t().editSource,
    icon: source.kind === "metrics" ? "ti ti-plug" : "ti ti-pencil",
    fields: sourceEditFields(source, t()),
    confirmText: t().save,
  });

  return sourcePatchFromResult(source, result);
};
