import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import MailMessageBody from "./MailMessageBody";

type MailMessageBodyProps = Parameters<typeof MailMessageBody>[0];

export type MailMessageBodyTrace = {
  loads: number[];
  srcdocChanges: number;
  heights: Array<{ at: number; value: string }>;
};

declare global {
  interface Window {
    mountMailMessageBody: (props: Omit<MailMessageBodyProps, "onSelectionChange">) => void;
    mailMessageBodyTrace: MailMessageBodyTrace;
  }
}

window.mountMailMessageBody = (props) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  const started = performance.now();
  const trace: MailMessageBodyTrace = { loads: [], srcdocChanges: 0, heights: [] };
  window.mailMessageBodyTrace = trace;
  render(() => createComponent(MailMessageBody, { ...props, onSelectionChange: () => {} }), host);
  const frame = host.querySelector("iframe");
  if (!frame) throw new Error("Missing message frame");
  trace.heights.push({ at: 0, value: frame.style.height });
  frame.addEventListener("load", () => trace.loads.push(Math.round(performance.now() - started)));
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.attributeName === "srcdoc") trace.srcdocChanges += 1;
      if (record.attributeName === "style") trace.heights.push({ at: Math.round(performance.now() - started), value: frame.style.height });
    }
  }).observe(frame, { attributes: true, attributeFilter: ["srcdoc", "style"] });
};
