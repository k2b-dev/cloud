import { createComponent } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
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
    mountMailMessageBody: (
      props: Omit<MailMessageBodyProps, "onSelectionChange" | "theme" | "colors"> & Partial<Pick<MailMessageBodyProps, "theme" | "colors">>,
    ) => void;
    /** Applies a live update to the mounted message, as a reconciled snapshot does. */
    updateMailMessageBody: (props: Partial<Omit<MailMessageBodyProps, "onSelectionChange">>) => void;
    /** Mounts the message body again with its current props, as the reader does when the message format changes. */
    remountMailMessageBody: () => void;
    mailMessageBodyTrace: MailMessageBodyTrace;
  }
}

window.mountMailMessageBody = (props) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  const started = performance.now();
  const trace: MailMessageBodyTrace = { loads: [], srcdocChanges: 0, heights: [], quoteToggles: 0 };
  window.mailMessageBodyTrace = trace;
  const [current, setCurrent] = createStore<MailMessageBodyProps>({
    theme: "light",
    colors: "adapted",
    ...props,
    onSelectionChange: () => {},
  });
  // The reader reconciles snapshots, so arrays such as the allow rules keep their identity and change in place.
  window.updateMailMessageBody = (update) => setCurrent(reconcile({ ...unwrap(current), ...update }));
  let dispose = render(() => createComponent(MailMessageBody, current), host);
  window.remountMailMessageBody = () => {
    dispose();
    dispose = render(() => createComponent(MailMessageBody, current), host);
  };
  const frame = host.querySelector("iframe");
  if (!frame) {
    if (props.format === "html") throw new Error("Missing message frame");
    return;
  }
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
