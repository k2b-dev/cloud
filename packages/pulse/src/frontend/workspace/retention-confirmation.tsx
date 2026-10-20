import { text } from "@k2b/stdlib";
import { prompts } from "@k2b/ui";
import { For } from "solid-js";
import type { BaseRetention, RetentionPreviewItem } from "../../store/admin-contracts";
import { baseStoreMessages } from "./base-store-messages";

/** The server's 409 for a shorter retention: what goes, from which date, and how much. */
export class RetentionConfirmationError extends Error {
  constructor(
    readonly preview: RetentionPreviewItem[],
    readonly previewedFrom: BaseRetention,
  ) {
    super("PULSE_RETENTION_CONFIRMATION_REQUIRED");
  }
}

const isPreviewItem = (value: unknown): value is RetentionPreviewItem =>
  Boolean(value) &&
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  ["raw", "rollup", "sensitive"].includes(String(value.kind)) &&
  "cutoff" in value &&
  typeof value.cutoff === "string" &&
  "rows" in value &&
  typeof value.rows === "number" &&
  "bytes" in value &&
  typeof value.bytes === "number";

/** Turns a refusal body into the confirmation error, or the server's message for every other refusal. */
export const baseUpdateError = (_status: number, body: unknown): Error => {
  if (body && typeof body === "object" && "code" in body && body.code === "PULSE_RETENTION_CONFIRMATION_REQUIRED") {
    const preview: unknown = "preview" in body ? body.preview : undefined;
    const previewedFrom = "previewedFrom" in body ? body.previewedFrom : undefined;
    if (
      Array.isArray(preview) &&
      preview.every(isPreviewItem) &&
      previewedFrom &&
      typeof previewedFrom === "object" &&
      "rawRetentionDays" in previewedFrom &&
      typeof previewedFrom.rawRetentionDays === "number" &&
      "rollupRetentionDays" in previewedFrom &&
      typeof previewedFrom.rollupRetentionDays === "number" &&
      "sensitiveRetentionHours" in previewedFrom &&
      typeof previewedFrom.sensitiveRetentionHours === "number"
    )
      return new RetentionConfirmationError(preview, {
        rawRetentionDays: previewedFrom.rawRetentionDays,
        rollupRetentionDays: previewedFrom.rollupRetentionDays,
        sensitiveRetentionHours: previewedFrom.sensitiveRetentionHours,
      });
  }
  return new Error(
    body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : "Request failed",
  );
};

/** Asks with date and amount before data goes; resolves true only on an explicit confirmation. */
export const confirmShorterRetention = async (preview: RetentionPreviewItem[], locale: string): Promise<boolean> => {
  const t = baseStoreMessages.resolve([locale]).t;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const line = (item: RetentionPreviewItem) => {
    const values = {
      rows: text.pprintNumber(item.rows, { locale }),
      bytes: text.pprintBytes(item.bytes, { locale, mode: "si" }),
      date: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(item.cutoff)),
    };
    return item.kind === "raw" ? t.confirmRaw(values) : item.kind === "rollup" ? t.confirmRollup(values) : t.confirmSensitive(values);
  };
  return (
    (await prompts.confirm(
      <div class="flex flex-col gap-3">
        <p>{t.confirmShorterIntro}</p>
        <ul class="flex list-disc flex-col gap-1 pl-5">
          <For each={preview}>{(item) => <li>{line(item)}</li>}</For>
        </ul>
      </div>,
      { title: t.confirmShorterTitle, confirmText: t.confirmShorter, variant: "danger", icon: "ti ti-trash" },
    )) === true
  );
};
