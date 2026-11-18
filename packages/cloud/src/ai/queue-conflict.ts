/** Admission conflicts shared by direct submissions and the durable queue. */
export class AiMessageQueueConflict extends Error {
  constructor(
    message: string,
    readonly code?: "queue_waiting" | "queue_held",
  ) {
    super(message);
  }
}
