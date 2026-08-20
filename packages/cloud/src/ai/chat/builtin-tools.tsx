import { fileIcons } from "@k2b/stdlib";
import { Chat } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import { formatAiFileSize } from "../attachments";
import type { AiTurnBlock } from "../protocol";
import { aiToolIcon, displayToolName, formatToolDetailText, isRecord } from "./message-utils";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

const SPECIALIZED_TOOL_NAMES = new Set([
  "search_tools",
  "load_tools",
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
  "local_bash",
  "read_cloud_resource",
]);

export const hasSpecializedBuiltinToolView = (name: string, result?: unknown): boolean =>
  SPECIALIZED_TOOL_NAMES.has(name) &&
  (name !== "read_cloud_resource" || (isRecord(result) && typeof result.summary === "string" && result.summary.trim().length > 0));

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path;

function ResultSurface(props: { children: JSX.Element }) {
  return (
    <div class="w-full min-w-0 rounded-md bg-zinc-100/70 p-1 text-xs [box-shadow:var(--ui-control-recess)] dark:bg-zinc-950/70">
      {props.children}
    </div>
  );
}

function EmptyRow(props: { children: JSX.Element }) {
  return <p class="px-2 py-1.5 text-dimmed">{props.children}</p>;
}

function ResultRow(props: { icon: string; title: string; description?: string; meta?: string }) {
  return (
    <div class="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5">
      <i class={`ti ${props.icon} mt-px shrink-0 text-sm text-dimmed`} aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <p class="truncate font-medium text-primary">{props.title}</p>
        <Show when={props.description}>
          <p class="line-clamp-2 text-dimmed">{props.description}</p>
        </Show>
      </div>
      <Show when={props.meta}>
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
    <Chat.Activity
      icon={aiToolIcon(props.block.name)}
      label={props.label}
      description={props.description}
      defaultOpen={props.defaultOpen}
      bodyInset={false}
    >
      {props.children}
    </Chat.Activity>
  );
}

function SearchToolsView(props: { block: ToolBlock }) {
  const args = () => (isRecord(props.block.args) ? props.block.args : {});
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const tools = () => records(result().tools);
  const query = () => text(args().query) || "Tools";
  return (
    <CompletedActivity block={props.block} label={`Search tools: ${query()}`} description={`${tools().length} found`} defaultOpen>
      <ResultSurface>
        <Show when={tools().length > 0} fallback={<EmptyRow>No tools found.</EmptyRow>}>
          <For each={tools()}>
            {(tool) => (
              <ResultRow
                icon={tool.kind === "action" ? "ti-bolt" : tool.kind === "query" ? "ti-search" : aiToolIcon(text(tool.name))}
                title={text(tool.title) || displayToolName(text(tool.name))}
                description={text(tool.description)}
                meta={text(tool.appId) || text(tool.kind)}
              />
            )}
          </For>
        </Show>
      </ResultSurface>
    </CompletedActivity>
  );
}

function ListAppsView(props: { block: ToolBlock }) {
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const apps = () => {
    const value = result().apps;
    return isRecord(value) ? Object.entries(value) : [];
  };
  return (
    <CompletedActivity block={props.block} label="List apps" description={`${apps().length} available`} defaultOpen>
      <ResultSurface>
        <Show when={apps().length > 0} fallback={<EmptyRow>No capability apps available.</EmptyRow>}>
          <For each={apps()}>{([appId, description]) => <ResultRow icon="ti-apps" title={appId} description={text(description)} />}</For>
        </Show>
      </ResultSurface>
    </CompletedActivity>
  );
}

function LoadToolsView(props: { block: ToolBlock }) {
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const groups = () =>
    (
      [
        ["Loaded", result().loaded],
        ["Already loaded", result().alreadyLoaded],
        ["Missing", result().missing],
        ["Evicted", result().evicted],
      ] as const
    ).flatMap(([label, value]) =>
      Array.isArray(value) && value.length > 0 ? [{ label, names: value.filter((name): name is string => typeof name === "string") }] : [],
    );
  const loadedCount = () => {
    const value = result().loaded;
    return Array.isArray(value) ? value.length : 0;
  };
  return (
    <CompletedActivity block={props.block} label="Load tools" description={`${loadedCount()} loaded`} defaultOpen={groups().length > 0}>
      <Show when={groups().length > 0}>
        <ResultSurface>
          <For each={groups()}>
            {(group) => (
              <div class="px-2 py-1.5">
                <p class="mb-1 text-[10px] font-medium uppercase tracking-wide text-dimmed">{group.label}</p>
                <div class="flex flex-wrap gap-1">
                  <For each={group.names}>
                    {(name) => <code class="rounded bg-white/65 px-1.5 py-0.5 text-[11px] text-secondary dark:bg-white/5">{name}</code>}
                  </For>
                </div>
              </div>
            )}
          </For>
        </ResultSurface>
      </Show>
    </CompletedActivity>
  );
}

function SearchHelpView(props: { block: ToolBlock }) {
  const args = () => (isRecord(props.block.args) ? props.block.args : {});
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const documents = () => records(result().documents);
  const query = () => text(args().query) || "Help";
  return (
    <CompletedActivity block={props.block} label={`Search help: ${query()}`} description={`${documents().length} found`} defaultOpen>
      <ResultSurface>
        <Show when={documents().length > 0} fallback={<EmptyRow>No Help articles found.</EmptyRow>}>
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
      </ResultSurface>
    </CompletedActivity>
  );
}

function ReadHelpView(props: { block: ToolBlock }) {
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const document = (): Record<string, unknown> | null => {
    const value = result().document;
    return isRecord(value) ? value : null;
  };
  return (
    <CompletedActivity
      block={props.block}
      label={document() ? `Read help: ${text(document()!.title)}` : "Read help"}
      description={document() ? text(document()!.appName) || text(document()!.appId) : "Article not found"}
    />
  );
}

function SearchProjectView(props: { block: ToolBlock }) {
  const args = () => (isRecord(props.block.args) ? props.block.args : {});
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const items = () => records(result().items);
  const query = () => text(args().query);
  return (
    <CompletedActivity
      block={props.block}
      label={query() ? `Search Project: ${query()}` : "List Project sources"}
      description={`${items().length} found${result().truncated === true ? "+" : ""}`}
      defaultOpen
    >
      <ResultSurface>
        <Show when={items().length > 0} fallback={<EmptyRow>No Project sources found.</EmptyRow>}>
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
      </ResultSurface>
    </CompletedActivity>
  );
}

function ReadProjectKnowledgeView(props: { block: ToolBlock }) {
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  return <CompletedActivity block={props.block} label={`Read Project knowledge: ${text(result().title) || "Entry"}`} />;
}

function ListFilesView(props: { block: ToolBlock }) {
  const args = () => (isRecord(props.block.args) ? props.block.args : {});
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const files = () => records(result().files);
  return (
    <CompletedActivity
      block={props.block}
      label={`List files: ${text(args().path) || "/"}`}
      description={`${files().length} found${result().truncated === true ? "+" : ""}`}
      defaultOpen
    >
      <ResultSurface>
        <Show when={files().length > 0} fallback={<EmptyRow>No files found.</EmptyRow>}>
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
      </ResultSurface>
    </CompletedActivity>
  );
}

function FileOperationView(props: { block: ToolBlock; verb: string; resultPath?: string }) {
  const args = () => (isRecord(props.block.args) ? props.block.args : {});
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const path = () => props.resultPath || text(result().path) || text(args().path);
  const size = () => number(result().size);
  return (
    <CompletedActivity
      block={props.block}
      label={`${props.verb}: ${basename(path()) || "File"}`}
      description={[path(), size() > 0 ? formatAiFileSize(size()) : ""].filter(Boolean).join(" · ")}
    />
  );
}

function ReadFileView(props: { block: ToolBlock }) {
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const path = () => text(result().path) || (isRecord(props.block.args) ? text(props.block.args.path) : "");
  const range = () => {
    const start = number(result().offset);
    const end = number(result().nextOffset);
    return end > start ? `bytes ${start.toLocaleString()}–${end.toLocaleString()}` : "Read";
  };
  return (
    <CompletedActivity
      block={props.block}
      label={`Read file: ${basename(path())}`}
      description={`${range()}${result().eof === true ? " · complete" : " · more available"}`}
    />
  );
}

function CalculateView(props: { block: ToolBlock }) {
  const args = () => (isRecord(props.block.args) ? props.block.args : {});
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  return <CompletedActivity block={props.block} label={text(args().expression) || "Calculate"} description={text(result().result)} />;
}

function ViewImageView(props: { block: ToolBlock }) {
  const args = () => (isRecord(props.block.args) ? props.block.args : {});
  const result = () => (isRecord(props.block.result) ? props.block.result : {});
  const path = () => text(result().path) || text(args().path);
  return (
    <CompletedActivity block={props.block} label={`Inspect image: ${basename(path())}`} defaultOpen>
      <ResultSurface>
        <p class="whitespace-pre-wrap px-2 py-1.5 leading-5 text-secondary">{text(result().description)}</p>
      </ResultSurface>
    </CompletedActivity>
  );
}

function LocalBashView(props: { block: ToolBlock }) {
  const args = () => (isRecord(props.block.args) ? props.block.args : {});
  return (
    <CompletedActivity block={props.block} label="Local Bash" defaultOpen>
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
  return (
    <CompletedActivity
      block={props.block}
      label={`Read resource: ${text(args().type)}:${text(args().id)}`}
      description={summary() || undefined}
    />
  );
}

export function SpecializedBuiltinToolBlock(props: { block: ToolBlock }) {
  switch (props.block.name) {
    case "search_tools":
      return <SearchToolsView block={props.block} />;
    case "load_tools":
      return <LoadToolsView block={props.block} />;
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
      return <FileOperationView block={props.block} verb="Wrote file" />;
    case "calculate":
      return <CalculateView block={props.block} />;
    case "view_image":
      return <ViewImageView block={props.block} />;
    case "markdown_to_pdf": {
      const result = isRecord(props.block.result) ? props.block.result : {};
      return <FileOperationView block={props.block} verb="Created PDF" resultPath={text(result.path)} />;
    }
    case "local_bash":
      return <LocalBashView block={props.block} />;
    case "read_cloud_resource":
      return <CloudResourceView block={props.block} />;
    default:
      return null;
  }
}
