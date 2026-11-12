import { lazySync } from "@k2b/cloud";

export type DraftDocumentCommit = {
  kind: "commit";
  generation: string;
  cursor: string;
  previousCursor: string | null;
  frozen: boolean;
};
export type DraftAwarenessEvent = {
  kind: "awareness";
  payload: string;
  generation: string;
  originNodeId: string;
  originPeerId: string;
};
/** Small committed-watermark notices share the existing transient topic, never document bytes.
 * SQL remains the recovery authority if a notice is lost between commit and publish.
 */
export const draftDocumentAwarenessTopic = lazySync((sync) =>
  sync.topic<DraftAwarenessEvent | DraftDocumentCommit>({
    id: "cloud:mail:draft-document-awareness",
    retention: { maxAgeMs: 60_000, maxBytes: 64 * 1024 * 1024 },
    dedupeWindowMs: 60_000,
    maxPayloadBytes: 300_000 + 4096,
  }),
);
