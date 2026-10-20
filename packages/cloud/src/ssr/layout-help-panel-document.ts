import type { HelpArticleLink, HelpDocumentManifest, HelpDocumentPayload } from "../shared/help";
import { HELP_ACCESS_LEVELS, HELP_KINDS } from "../shared/help";
import type { HelpPanelState } from "./layout-help-panel-state";

const optionalString = (value: object, key: string): string | undefined => {
  const field = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
};
/** A linked article from the Help API, or nothing when the server sent something else. */
const articleLink = (value: unknown): HelpArticleLink | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const [appId, appName, documentId, title, url] = ["appId", "appName", "documentId", "title", "url"].map((key) =>
    optionalString(value, key),
  );
  if (!appId || !appName || !documentId || !title || !url?.startsWith("/")) return undefined;
  const [accent, description, icon] = ["accent", "description", "icon"].map((key) => optionalString(value, key));
  return { appId, appName, accent, documentId, title, description, icon, url };
};

export const loadPanelDocument = async (
  state: HelpPanelState,
  topic: HelpDocumentManifest,
  signal: AbortSignal,
  t: { requestFailed: string; invalidDocument: string },
) => {
  const cacheKey = `${topic.locale ?? "en"}:${topic.url}`;
  const cached = state.cache.get(cacheKey);
  if (cached) return cached;

  const response = await fetch(topic.url, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(t.requestFailed);
  const value: unknown = await response.json();
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    value.id !== topic.id ||
    !("html" in value) ||
    !("markdown" in value) ||
    !("title" in value) ||
    ("locale" in value && value.locale !== undefined && typeof value.locale !== "string") ||
    (topic.locale !== undefined && "locale" in value && value.locale !== undefined && value.locale !== topic.locale) ||
    typeof value.html !== "string" ||
    typeof value.markdown !== "string" ||
    typeof value.title !== "string"
  ) {
    throw new Error(t.invalidDocument);
  }
  const kind = Reflect.get(value, "kind");
  const needs = Reflect.get(value, "needs");
  const related = Reflect.get(value, "related");
  const next = articleLink(Reflect.get(value, "next"));
  const document: HelpDocumentPayload = {
    id: topic.id,
    title: value.title,
    html: value.html,
    markdown: value.markdown,
    locale: "locale" in value && typeof value.locale === "string" ? value.locale : (topic.locale ?? "en"),
    // A Core older than the app's Help reader sends no article facts; the article then shows none.
    kind: HELP_KINDS.find((candidate) => candidate === kind) ?? "task",
    needs: HELP_ACCESS_LEVELS.find((level) => level === needs),
    ...(next ? { next } : {}),
    related: Array.isArray(related) ? related.flatMap((link) => articleLink(link) ?? []) : [],
  };
  state.storeDocument(topic, document);
  return document;
};
