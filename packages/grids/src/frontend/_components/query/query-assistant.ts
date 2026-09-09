import { type LaunchAssistantInput, launchAssistant } from "@valentinkolb/cloud/ai/browser";

/** This ceiling is persisted by Cloud; preloading alone does not restrict a chat. */
export const GRIDS_QUERY_TOOLS = [
  "grids.base.list",
  "grids.base.search",
  "grids.base.read",
  "grids.table.read",
  "grids.view.read",
  "grids.gql.context",
  "grids.gql.preview",
  "grids.gql.execute",
  "grids.gql.view.execute",
  "grids.record.read",
  "grids.view.create",
  "search_help",
  "read_help",
  "search_skills",
  "load_skill",
  "read_file",
  "read_cloud_resource",
];

export const queryAssistantInput = (input: {
  baseId: string;
  baseName?: string;
  query: string;
  currentSource?: ({ kind: "table"; tableId: string } | { kind: "view"; viewId: string }) & { label?: string };
  title: string;
  prompt: string;
}): LaunchAssistantInput => ({
  title: input.title,
  launchedByAppId: "grids",
  allowedTools: GRIDS_QUERY_TOOLS,
  skills: ["cloud-grids"],
  preloadTools: [
    { appId: "grids", kind: "query", id: "gql.context" },
    { appId: "grids", kind: "query", id: "gql.preview" },
    { appId: "grids", kind: "query", id: "gql.execute" },
    { appId: "grids", kind: "action", id: "view.create" },
  ],
  draft: {
    content: [
      { type: "text", text: input.prompt },
      {
        type: "resource",
        ref: { type: "grids.base", id: input.baseId },
        title: input.baseName,
        icon: "ti ti-table",
        href: `/app/grids/${input.baseId}`,
      },
      ...(input.currentSource
        ? [
            {
              type: "resource" as const,
              ref: {
                type: `grids.${input.currentSource.kind}`,
                id: input.currentSource.kind === "table" ? input.currentSource.tableId : input.currentSource.viewId,
              },
              title: input.currentSource.label,
              icon: input.currentSource.kind === "table" ? "ti ti-table" : "ti ti-eye",
            },
          ]
        : []),
      ...(input.query ? [{ type: "text" as const, text: input.query }] : []),
    ],
  },
});

export const launchQueryAssistant = (input: Parameters<typeof queryAssistantInput>[0]) => launchAssistant(queryAssistantInput(input));
