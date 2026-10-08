// Check-only prelude: the normal app realm plus host-owned inspection.
// Configure Zod without eval before loading the inspection schemas.
import "./no-eval";
import { inspectApp } from "./check-realm";
import { clip, host, send, settleRequests, show } from "./frame";
import type { HostToFrame } from "./protocol";

addEventListener("message", (event: MessageEvent) => {
  if (event.source !== host) return;
  const message = event.data as HostToFrame;
  if (message?.type !== "check") return;
  void inspectApp(message.input, settleRequests).then(
    (value) => send({ type: "check-result", id: message.id, value }),
    (error) => send({ type: "check-result", id: message.id, error: clip(error instanceof Error ? error.message : show(error)) }),
  );
});
