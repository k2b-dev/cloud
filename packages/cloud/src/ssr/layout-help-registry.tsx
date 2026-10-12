import type { HelpDocumentManifest } from "@k2b/cloud/shared";
import { type JSX, onCleanup, onMount } from "solid-js";

type HelpTopicBase = {
  id: string;
  title: string;
  icon?: string;
  description?: string;
  order?: number;
};

export type LayoutHelpDocumentsProps = {
  documents: readonly HelpDocumentManifest[];
  /** Canonical standalone Help route owned by the current app. */
  pageBase: string;
};
export type HelpTopic = (HelpTopicBase & { kind: "content"; children: JSX.Element }) | (HelpDocumentManifest & { kind: "document" });

export const HELP_TOPICS_EVENT = "cloud:layout-help-topics";

declare global {
  interface Window {
    __cloudLayoutHelpTopics?: Map<string, HelpTopic>;
    __cloudLayoutHelpPageBase?: string;
  }
}

export const registry = () => {
  if (typeof window === "undefined") return null;
  window.__cloudLayoutHelpTopics ??= new Map<string, HelpTopic>();
  return window.__cloudLayoutHelpTopics;
};

const emitTopicsChanged = () => window.dispatchEvent(new Event(HELP_TOPICS_EVENT));
const registerTopic = (topic: HelpTopic) => {
  const topics = registry();
  if (!topics) return () => {};
  topics.set(topic.id, topic);
  emitTopicsChanged();
  return () => {
    if (topics.get(topic.id) !== topic) return;
    topics.delete(topic.id);
    emitTopicsChanged();
  };
};

/** Register an app's server-prepared Markdown manifest with the shared help UI. */
export function LayoutHelpDocuments(props: LayoutHelpDocumentsProps) {
  onMount(() => {
    // Cleanup runs while this unmounts, when a parent `<Show>` may already have dropped the props' source.
    const pageBase = props.pageBase;
    window.__cloudLayoutHelpPageBase = pageBase;
    const disposers = props.documents.map((document) => registerTopic({ ...document, kind: "document" }));
    onCleanup(() => {
      disposers.forEach((dispose) => dispose());
      if (window.__cloudLayoutHelpPageBase === pageBase) delete window.__cloudLayoutHelpPageBase;
    });
  });
  return null;
}
