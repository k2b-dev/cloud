import { createComponent } from "solid-js";
import { createStore } from "solid-js/store";
import { render } from "solid-js/web";
import MailMessageBody from "./MailMessageBody";

type MailMessageBodyProps = Parameters<typeof MailMessageBody>[0];

export type MailMessageBodyTrace = {
  loads: number[];
  srcdocChanges: number;
  heights: Array<{ at: number; value: string }>;
  quoteToggles: number;
};

declare global {
  interface Window {
    mountMailMessageBody: (props: Omit<MailMessageBodyProps, "onSelectionChange">) => void;
    /** Applies a live update to the mounted message, as a reconciled snapshot does. */
    updateMailMessageBody: (props: Partial<Omit<MailMessageBodyProps, "onSelectionChange">>) => void;
    mailMessageBodyTrace: MailMessageBodyTrace;
  }
}

window.mountMailMessageBody = (props) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  const started = performance.now();
  const trace: MailMessageBodyTrace = { loads: [], srcdocChanges: 0, heights: [], quoteToggles: 0 };
  window.mailMessageBodyTrace = trace;
  const [current, setCurrent] = createStore<MailMessageBodyProps>({ ...props, onSelectionChange: () => {} });
  window.updateMailMessageBody = (update) => setCurrent(update);
  render(() => createComponent(MailMessageBody, current), host);
  const frame = host.querySelector("iframe");
  if (!frame) throw new Error("Missing message frame");
  trace.heights.push({ at: 0, value: frame.style.height });
  frame.addEventListener("load", () => trace.loads.push(Math.round(performance.now() - started)));
  window.addEventListener("message", (event) => {
    if (event.data?.source === "cloud-mail-message" && event.data.type === "quote") trace.quoteToggles += 1;
  });
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.attributeName === "srcdoc") trace.srcdocChanges += 1;
      if (record.attributeName === "style") trace.heights.push({ at: Math.round(performance.now() - started), value: frame.style.height });
    }
  }).observe(frame, { attributes: true, attributeFilter: ["srcdoc", "style"] });
};
