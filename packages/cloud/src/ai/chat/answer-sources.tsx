import { useLocale } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import type { AiTurnBlock } from "../protocol";
import { answerCitations } from "./answer-links";
import { isRecord } from "./message-utils";
import { aiChatMessages } from "./messages";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

/** One numbered source under an answer: what the citation opens, and which app it belongs to. */
export type AiAnswerSource = {
  number: number;
  href: string;
  title: string;
  /** Icon class of the owning app, or of a web page. */
  icon: string;
  /** The owning app's colour; a web page and an unknown app stay neutral. */
  accent?: string;
};

const isWeb = (href: string) => /^https?:\/\//i.test(href);

/** The app a Cloud link belongs to: `/open/mail.thread/~…` and `/app/mail/…` belong to Mail. */
const appOf = (href: string): string | null =>
  /^\/(?:open\/([a-z0-9-]+)[.:/]|app\/([a-z0-9-]+)\/)/i.exec(href)?.slice(1).find(Boolean) ?? null;

const textOf = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null);

/** Values one result walk visits at most; results can be large. */
const RESULT_WALK_LIMIT = 2_000;

/**
 * The titles a result gives the objects it names: every object with an `href` or `url` and a `title` or `name`. One
 * bounded breadth-first walk per result.
 */
const namedLinks = (result: unknown): Map<string, string> => {
  const titles = new Map<string, string>();
  const queue: unknown[] = [result];
  for (let index = 0; index < queue.length && index < RESULT_WALK_LIMIT; index += 1) {
    const value = queue[index];
    const children = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
    if (isRecord(value)) {
      const title = textOf(value.title) ?? textOf(value.name);
      for (const link of [value.href, value.url]) if (title && typeof link === "string" && !titles.has(link)) titles.set(link, title);
    }
    for (const child of children) {
      if (queue.length >= RESULT_WALK_LIMIT) break;
      if (child !== null && typeof child === "object") queue.push(child);
    }
  }
  return titles;
};

/**
 * The sources an answer cites, numbered as in its rendered HTML, with the title and app the turn's results give them. A
 * cited link no result names keeps its number with the app's name or the web page's host as its title.
 */
export const answerSources = (html: string, blocks: AiTurnBlock[]): AiAnswerSource[] => {
  const citations = answerCitations(html);
  if (citations.length === 0) return [];
  const tools = blocks.filter((block): block is ToolBlock => block.kind === "tool" && block.status === "completed" && !block.isError);
  const named = new Map<string, { title: string; tool: ToolBlock }>();
  for (const tool of tools) for (const [link, title] of namedLinks(tool.result)) if (!named.has(link)) named.set(link, { title, tool });
  return citations.map(({ number, href }) => {
    const found = named.get(href);
    const app = appOf(href);
    const owner = found?.tool.presentation ?? tools.find((tool) => tool.presentation?.appId === app)?.presentation;
    const web = isWeb(href);
    const host = web ? (/^https?:\/\/(?:www\.)?([^/?#]+)/i.exec(href)?.[1] ?? null) : null;
    return {
      number,
      href,
      title: found?.title ?? owner?.appName ?? host ?? href,
      icon: owner?.appIcon ?? (web ? "ti ti-world" : "ti ti-link"),
      accent: owner?.appAccent,
    };
  });
};

/** An app's icon tile, 20 px: the icon in the app colour on its tint (`k2b-icon-tile`). Without a colour it stays neutral. */
export function AiAppTile(props: { icon: string; accent?: string; class?: string }): JSX.Element {
  return (
    <span
      class={`k2b-icon-tile ai-app-tile ${props.class ?? ""}`}
      style={props.accent ? { color: props.accent } : undefined}
      aria-hidden="true"
    >
      <i class={props.icon} />
    </span>
  );
}

/**
 * The row under an answer: "Sources", then one grey pill per source with its number, app tile, and title. The number
 * matches the chip in the text and opens the same way: in a new tab, like every link in an answer.
 */
export function AiAnswerSources(props: { sources: AiAnswerSource[] }): JSX.Element {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  return (
    <Show when={props.sources.length > 0}>
      <div class="ai-sources" role="group" aria-label={t().sources}>
        <span class="ai-sources__label" aria-hidden="true">
          {t().sources}
        </span>
        <ul class="ai-sources__list">
          <For each={props.sources}>
            {(source) => (
              <li>
                <a
                  class="ai-source"
                  href={source.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={source.title}
                  aria-label={t().sourceLabel({ number: source.number, title: source.title })}
                >
                  <span class="ai-source__number">{source.number}</span>
                  <AiAppTile icon={source.icon} accent={source.accent} />
                  <span class="ai-source__title k2b-truncate-fade">{source.title}</span>
                </a>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}
