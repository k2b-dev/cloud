import { fileIcons } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import { formatAiFileSize } from "../attachments";
import type { AiTurnBlock } from "../protocol";
import { aiToolIcon, displayToolName, formatToolDetailText, isRecord } from "./message-utils";
import { aiChatMessages } from "./messages";
import { AiToolActivity } from "./tool-disclosure";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

const SPECIALIZED_TOOL_NAMES = new Set([
  "search_tools",
  "load_tools",
  "load_skill",
  "list_apps",
  "search_help",
  "read_help",
  "search_project",
  "read_project_knowledge",
  "list_files",
  "read_file",
  "write_file",
  "calculate",
  "view_image",
  "markdown_to_pdf",
  "html_to_pdf",
  "local_bash",
  "read_cloud_resource",
]);

export const hasSpecializedBuiltinToolView = (name: string, result?: unknown): boolean =>
  SPECIALIZED_TOOL_NAMES.has(name) &&
  (name !== "load_skill" || (isRecord(result) && typeof result.name === "string" && typeof result.description === "string")) &&
  (name !== "read_cloud_resource" || (isRecord(result) && typeof result.summary === "string" && result.summary.trim().length > 0));

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path;
const useMessages = () => {
  const locale = useLocale();
  return () => aiChatMessages(locale());
};

function DetailSurface(props: { children: JSX.Element }) {
  return (
    <div class="w-full min-w-0 rounded-md bg-zinc-100/70 p-1 text-xs [box-shadow:var(--ui-control-recess)] dark:bg-zinc-950/70">
      {props.children}
    </div>
  );
}

function ResultList(props: { children: JSX.Element }) {
  return <div class="flex w-full min-w-0 flex-col text-xs">{props.children}</div>;
}

function EmptyRow(props: { children: JSX.Element }) {
  return <p class="px-2 py-1.5 text-dimmed">{props.children}</p>;
}

function ResultRow(props: { icon: string; title: string; description?: string; meta?: string }) {
  return (
    <div class="flex min-w-0 items-center gap-1.5 px-2 py-1.5">
      <i class={`ti ${props.icon} shrink-0 text-sm text-dimmed`} aria-hidden="true" />
      <span class="max-w-[42%] shrink-0 truncate font-medium text-primary">{props.title}</span>
      <Show when={props.description}>
        <span class="shrink-0 text-dimmed" aria-hidden="true">
          ·
        </span>
        <span class="min-w-0 flex-1 truncate text-dimmed">{props.description}</span>
      </Show>
      <Show when={props.meta}>
        <span class="shrink-0 text-dimmed" aria-hidden="true">
          ·
        </span>
        <span class="shrink-0 text-[11px] text-dimmed">{props.meta}</span>
      </Show>
    </div>
  );
}

function CompletedActivity(props: {
  block: ToolBlock;
  label: string;
  description?: string;
  defaultOpen?: boolean;
  children?: JSX.Element;
}) {
  return (
    <AiToolActivity
      blockId={props.block.id}
      icon={aiToolIcon(props.block.name)}
      label={props.label}
      description={props.description}
      defaultOpen={props.defaultOpen}
      bodyInset={false}
    >
      {props.children}
    </AiToolActivity>
  );
}

function SearchToolsView(props: { block: ToolBlock }) {
  const args = () => (isRecord(props.block.args) ? props.block.args : {});
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const tools = () => records(result().tools);
  const t = useMessages();
  const locale = useLocale();
  const query = () => text(args().query) || t().tools;
  return (
    <CompletedActivity block={props.block} label={t().searchTools({ query: query() })} description={t().found({ count: tools().length })}>
      <ResultList>
        <Show when={tools().length > 0} fallback={<EmptyRow>{t().noTools}</EmptyRow>}>
          <For each={tools()}>
            {(tool) => (
              <ResultRow
                icon={tool.kind === "action" ? "ti-bolt" : tool.kind === "query" ? "ti-search" : aiToolIcon(text(tool.name))}
                title={text(tool.title) || displayToolName(text(tool.name), locale())}
                description={text(tool.description)}
                meta={text(tool.appId) || text(tool.kind)}
              />
            )}
          </For>
        </Show>
      </ResultList>
    </CompletedActivity>
  );
}

function ListAppsView(props: { block: ToolBlock }) {
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const apps = () => {
    const value = result().apps;
    return isRecord(value) ? Object.entries(value) : [];
  };
  const t = useMessages();
  return (
    <CompletedActivity block={props.block} label={t().listApps} description={t().available({ count: apps().length })}>
      <ResultList>
        <Show when={apps().length > 0} fallback={<EmptyRow>{t().noApps}</EmptyRow>}>
          <For each={apps()}>{([appId, description]) => <ResultRow icon="ti-apps" title={appId} description={text(description)} />}</For>
        </Show>
      </ResultList>
    </CompletedActivity>
  );
}

/** Entries are `{name}` records; turns stored before #528 hold plain names and a `missing` list. */
const toolNames = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((item) => (typeof item === "string" ? [item] : isRecord(item) && typeof item.name === "string" ? [item.name] : []))
    : [];

function LoadToolsView(props: { block: ToolBlock }) {
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const titles = (): Record<string, unknown> => {
    const value = result().titles;
    return isRecord(value) ? value : {};
  };
  const t = useMessages();
  const unavailableLabel = (reason: unknown) =>
    reason === "not_offered_in_turn"
      ? t().toolNotOffered
      : reason === "not_allowed"
        ? t().toolNotAllowed
        : reason === "app_offline"
          ? t().toolAppOffline
          : t().toolUnknown;
  const rows = () => [
    ...toolNames(result().loaded).map((name) => ({ name, label: t().toolsLoaded })),
    ...toolNames(result().alreadyLoaded).map((name) => ({ name, label: t().toolsAlreadyLoaded })),
    ...records(result().unavailable).flatMap((item) =>
      typeof item.name === "string" ? [{ name: item.name, label: unavailableLabel(item.reason) }] : [],
    ),
    ...toolNames(result().missing).map((name) => ({ name, label: t().toolUnknown })),
    ...toolNames(result().evicted).map((name) => ({ name, label: t().toolsEvicted })),
  ];
  return (
    <CompletedActivity
      block={props.block}
      label={t().loadTools}
      description={t().loadedCount({ count: toolNames(result().loaded).length })}
    >
      <Show when={rows().length > 0}>
        <ResultList>
          <For each={rows()}>
            {(row) => <ResultRow icon={aiToolIcon(row.name)} title={text(titles()[row.name]) || row.name} meta={row.label} />}
          </For>
        </ResultList>
      </Show>
    </CompletedActivity>
  );
}

function LoadSkillView(props: { block: ToolBlock }) {
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const t = useMessages();
  return (
    <CompletedActivity block={props.block} label={t().loadedSkill({ name: text(result().name) })}>
      <DetailSurface>
        <p class="whitespace-pre-wrap px-2 py-1.5 leading-5 text-secondary">{text(result().description)}</p>
      </DetailSurface>
    </CompletedActivity>
  );
}

function SearchHelpView(props: { block: ToolBlock }) {
  const args = () => (isRecord(props.block.args) ? props.block.args : {});
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const documents = () => records(result().documents);
  const t = useMessages();
  const query = () => text(args().query) || t().help;
  return (
    <CompletedActivity
      block={props.block}
      label={t().searchHelp({ query: query() })}
      description={t().found({ count: documents().length })}
    >
      <ResultList>
        <Show when={documents().length > 0} fallback={<EmptyRow>{t().noHelp}</EmptyRow>}>
          <For each={documents()}>
            {(document) => (
              <ResultRow
                icon="ti-help-circle"
                title={text(document.title) || text(document.documentId)}
                description={text(document.description)}
                meta={text(document.appName) || text(document.appId)}
              />
            )}
          </For>
        </Show>
      </ResultList>
    </CompletedActivity>
  );
}

function ReadHelpView(props: { block: ToolBlock }) {
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const document = (): Record<string, unknown> | null => {
    const value = result().document;
    return isRecord(value) ? value : null;
  };
  const t = useMessages();
  return (
    <CompletedActivity
      block={props.block}
      label={document() ? t().readHelpArticle({ title: text(document()!.title) }) : t().readHelp}
      description={document() ? text(document()!.appName) || text(document()!.appId) : t().articleNotFound}
    />
  );
}

function SearchProjectView(props: { block: ToolBlock }) {
  const args = () => (isRecord(props.block.args) ? props.block.args : {});
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const items = () => records(result().items);
  const query = () => text(args().query);
  const t = useMessages();
  return (
    <CompletedActivity
      block={props.block}
      label={query() ? t().searchProject({ query: query() }) : t().listProjectSources}
      description={t().found({ count: items().length, more: result().truncated === true })}
    >
      <ResultList>
        <Show when={items().length > 0} fallback={<EmptyRow>{t().noProjectSources}</EmptyRow>}>
          <For each={items()}>
            {(item) => {
              const kind = text(item.kind);
              const path = text(item.path);
              const ref = isRecord(item.ref) ? `${text(item.ref.type)}:${text(item.ref.id)}` : "";
              return (
                <ResultRow
                  icon={
                    kind === "file"
                      ? fileIcons.getFileIcon({ name: basename(path), type: "file", mimeType: text(item.mediaType) })
                      : kind === "reference"
                        ? "ti-link"
                        : "ti-book"
                  }
                  title={text(item.title) || basename(path) || ref}
                  description={path || ref}
                  meta={kind}
                />
              );
            }}
          </For>
        </Show>
      </ResultList>
    </CompletedActivity>
  );
}

function ReadProjectKnowledgeView(props: { block: ToolBlock }) {
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const t = useMessages();
  return <CompletedActivity block={props.block} label={t().readProjectKnowledge({ title: text(result().title) || t().projectEntry })} />;
}

function ListFilesView(props: { block: ToolBlock }) {
  const args = () => (isRecord(props.block.args) ? props.block.args : {});
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const files = () => records(result().files);
  const t = useMessages();
  return (
    <CompletedActivity
      block={props.block}
      label={t().listFiles({ path: text(args().path) || "/" })}
      description={t().found({ count: files().length, more: result().truncated === true })}
    >
      <ResultList>
        <Show when={files().length > 0} fallback={<EmptyRow>{t().noFiles}</EmptyRow>}>
          <For each={files()}>
            {(file) => {
              const path = text(file.path);
              return (
                <ResultRow
                  icon={fileIcons.getFileIcon({ name: basename(path), type: "file", mimeType: text(file.mediaType) })}
                  title={basename(path)}
                  description={path}
                  meta={number(file.size) > 0 ? formatAiFileSize(number(file.size)) : text(file.origin)}
                />
              );
            }}
          </For>
        </Show>
      </ResultList>
    </CompletedActivity>
  );
}

function FileOperationView(props: { block: ToolBlock; verb: string; resultPath?: string }) {
  const args = () => (isRecord(props.block.args) ? props.block.args : {});
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const path = () => props.resultPath || text(result().path) || text(args().path);
  const size = () => number(result().size);
  const t = useMessages();
  return (
    <CompletedActivity
      block={props.block}
      label={`${props.verb}: ${basename(path()) || t().file}`}
      description={[path(), size() > 0 ? formatAiFileSize(size()) : ""].filter(Boolean).join(" · ")}
    />
  );
}

function CreatedPdfView(props: { block: ToolBlock }) {
  const locale = useLocale();
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  return <FileOperationView block={props.block} verb={aiChatMessages(locale()).createdPdf} resultPath={text(result().path)} />;
}

function ReadFileView(props: { block: ToolBlock }) {
  const locale = useLocale();
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const path = () => text(result().path) || (isRecord(props.block.args) ? text(props.block.args.path) : "");
  const range = () => {
    const start = number(result().offset);
    const end = number(result().nextOffset);
    const t = aiChatMessages(locale());
    return end > start ? t.byteRange({ start: start.toLocaleString(locale()), end: end.toLocaleString(locale()) }) : t.read;
  };
  const t = () => aiChatMessages(locale());
  return (
    <CompletedActivity
      block={props.block}
      label={t().readFile({ name: basename(path()) })}
      description={`${range()} · ${result().eof === true ? t().fileComplete : t().fileMoreAvailable}`}
    />
  );
}

function CalculateView(props: { block: ToolBlock }) {
  const args = () => (isRecord(props.block.args) ? props.block.args : {});
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const t = useMessages();
  return <CompletedActivity block={props.block} label={text(args().expression) || t().calculate} description={text(result().result)} />;
}

function ViewImageView(props: { block: ToolBlock }) {
  const args = () => (isRecord(props.block.args) ? props.block.args : {});
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const path = () => text(result().path) || text(args().path);
  const t = useMessages();
  return (
    <CompletedActivity block={props.block} label={t().inspectImage({ name: basename(path()) })} defaultOpen>
      <DetailSurface>
        <p class="whitespace-pre-wrap px-2 py-1.5 leading-5 text-secondary">{text(result().description)}</p>
      </DetailSurface>
    </CompletedActivity>
  );
}

function LocalBashView(props: { block: ToolBlock }) {
  const args = () => (isRecord(props.block.args) ? props.block.args : {});
  return (
    <CompletedActivity block={props.block} label="Local Bash">
      <div class="flex w-full min-w-0 flex-col gap-2">
        <pre class="max-h-40 w-full min-w-0 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-100 p-2 font-mono text-[11px] leading-4 text-primary [box-shadow:var(--ui-control-recess)] dark:bg-zinc-950/70">
          {text(args().command)}
        </pre>
        <pre class="max-h-64 w-full min-w-0 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-100 p-2 font-mono text-[11px] leading-4 text-primary [box-shadow:var(--ui-control-recess)] dark:bg-zinc-950/70">
          {formatToolDetailText(props.block.name, props.block.result)}
        </pre>
      </div>
    </CompletedActivity>
  );
}

function CloudResourceView(props: { block: ToolBlock }) {
  const args = () => (isRecord(props.block.args) ? props.block.args : {});
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const summary = () => text(result().summary);
  const t = useMessages();
  return (
    <CompletedActivity
      block={props.block}
      label={t().readResource({ ref: `${text(args().type)}:${text(args().id)}` })}
      description={summary() || undefined}
    />
  );
}

function WriteFileView(props: { block: ToolBlock }) {
  const t = useMessages();
  return <FileOperationView block={props.block} verb={t().wroteFile} />;
}

export function SpecializedBuiltinToolBlock(props: { block: ToolBlock }) {
  switch (props.block.name) {
    case "search_tools":
      return <SearchToolsView block={props.block} />;
    case "load_tools":
      return <LoadToolsView block={props.block} />;
    case "load_skill":
      return <LoadSkillView block={props.block} />;
    case "list_apps":
      return <ListAppsView block={props.block} />;
    case "search_help":
      return <SearchHelpView block={props.block} />;
    case "read_help":
      return <ReadHelpView block={props.block} />;
    case "search_project":
      return <SearchProjectView block={props.block} />;
    case "read_project_knowledge":
      return <ReadProjectKnowledgeView block={props.block} />;
    case "list_files":
      return <ListFilesView block={props.block} />;
    case "read_file":
      return <ReadFileView block={props.block} />;
    case "write_file":
      return <WriteFileView block={props.block} />;
    case "calculate":
      return <CalculateView block={props.block} />;
    case "view_image":
      return <ViewImageView block={props.block} />;
    case "markdown_to_pdf":
    case "html_to_pdf":
      return <CreatedPdfView block={props.block} />;
    case "local_bash":
      return <LocalBashView block={props.block} />;
    case "read_cloud_resource":
      return <CloudResourceView block={props.block} />;
    default:
      return null;
  }
}
