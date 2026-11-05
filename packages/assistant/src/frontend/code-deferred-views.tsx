import type { ComponentProps } from "solid-js";
import { DeferredCodeContent } from "./deferred-code-content";

// The Code destinations are rare, so their code stays out of the workspace's first download. They render the same
// loading surface on the server and on every first client render; the workspace keeps their already authorized SSR
// seed in props only while the page still shows what the server rendered, and they consume it when the code arrives.
const loadAssistantCodeView = () => import("./AssistantCodeView").then((module) => module.default);
export const AssistantCodeView = (props: ComponentProps<typeof import("./AssistantCodeView").default>) => (
  <DeferredCodeContent load={loadAssistantCodeView} contentProps={props} />
);
const loadAssistantCodeDetail = () => import("./AssistantCodeDetail").then((module) => module.default);
export const AssistantCodeDetail = (props: ComponentProps<typeof import("./AssistantCodeDetail").default>) => (
  <DeferredCodeContent load={loadAssistantCodeDetail} contentProps={props} />
);
