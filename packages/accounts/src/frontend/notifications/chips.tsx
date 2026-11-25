import type { NotificationBatch } from "@k2b/cloud/services";
import { Chip } from "@k2b/ui/v2";

export type BatchStatus = NotificationBatch["status"];

/** A batch's state as a chip: done is ok, errors are bad, what runs or waits is a warning, the rest rests. */
export const batchChip = (status: BatchStatus, label: string) =>
  status === "completed" ? (
    <Chip status="ok">{label}</Chip>
  ) : status === "completed_with_errors" || status === "failed" ? (
    <Chip status="bad">{label}</Chip>
  ) : status === "running" || status === "ready" ? (
    <Chip status="warn">{label}</Chip>
  ) : (
    <Chip>{label}</Chip>
  );
