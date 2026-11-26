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

/** The mark of a notification batch: a sent mail in the blue of the administration. */
export const BATCH_MARK = { icon: "mail-share", color: "#0284c7" };

/** The mark of a group, in the violet of groups across Accounts. */
export const GROUP_MARK = { icon: "users-group", color: "#7c3aed" };
