import type { ComponentProps, JSX } from "solid-js";
import { DeferredCodeContent } from "./deferred-code-content";

// The Code destinations are rare, so their code stays out of the workspace's first download. They render the same
// loading surface on the server and on every first client render; the workspace keeps their already authorized SSR
// seed in props only while the page still shows what the server rendered, and they consume it when the code arrives.
const loadAssistantCodeView = () => import("./AssistantCodeView").then((module) => module.default);
export const AssistantCodeView = (props: ComponentProps<typeof import("./AssistantCodeView").default>) => (
  <DeferredCodeContent load={loadAssistantCodeView} contentProps={props} />
);
// v2's My apps & automations: the same seed, drawn on v2; its pane stands while the code loads.
const loadAssistantAppsV2 = () => import("./v2/AssistantAppsV2").then((module) => module.default);
export const AssistantAppsV2 = (
  props: ComponentProps<typeof import("./v2/AssistantAppsV2").default> & {
    waiting: (state: { failed: boolean; retry: () => void }) => JSX.Element;
  },
) => <DeferredCodeContent load={loadAssistantAppsV2} contentProps={props} waiting={props.waiting} />;
// v2's settings page: rare, so its code (and v1's settings parts it still draws) loads when it opens.
const loadAssistantPrefsV2 = () => import("./v2/AssistantPrefsV2").then((module) => module.default);
export const AssistantPrefsV2 = (
  props: ComponentProps<typeof import("./v2/AssistantPrefsV2").default> & {
    waiting: (state: { failed: boolean; retry: () => void }) => JSX.Element;
  },
) => <DeferredCodeContent load={loadAssistantPrefsV2} contentProps={props} waiting={props.waiting} />;
// v2's Project settings page: rare, so its code loads when it opens.
const loadAssistantProjectSettingsV2 = () => import("./v2/AssistantProjectSettingsV2").then((module) => module.default);
export const AssistantProjectSettingsV2 = (
  props: ComponentProps<typeof import("./v2/AssistantProjectSettingsV2").default> & {
    waiting: (state: { failed: boolean; retry: () => void }) => JSX.Element;
  },
) => <DeferredCodeContent load={loadAssistantProjectSettingsV2} contentProps={props} waiting={props.waiting} />;
const loadAssistantCodeDetail = () => import("./AssistantCodeDetail").then((module) => module.default);
export const AssistantCodeDetail = (props: ComponentProps<typeof import("./AssistantCodeDetail").default>) => (
  <DeferredCodeContent load={loadAssistantCodeDetail} contentProps={props} />
);
