import type { AuthContext } from "@valentinkolb/cloud/server";
import type { Context } from "hono";
import type { GridsWorkspaceState } from "../frontend/_components/workspace/workspace-state";
import { type DslCurrentSource, executeGqlSource, executeSavedViewSource } from "./gql-runtime";
import { apiMessages } from "./messages";

type OkWorkspaceState = Extract<GridsWorkspaceState, { kind: "ok" }>;
type QueryRoute = Extract<OkWorkspaceState["route"], { kind: "query" }>;

const currentSourceForPreview = (source: QueryRoute["currentSource"]): DslCurrentSource => {
  if (!source) return undefined;
  return source.kind === "table" ? { kind: "table", tableId: source.tableId } : { kind: "view", viewId: source.viewId };
};

export const withInitialGqlResults = async <T extends GridsWorkspaceState>(c: Context, state: T): Promise<T> => {
  if (state.kind !== "ok") return state;
  const authContext = c as unknown as Context<AuthContext>;
  if (state.route.kind === "queryResultView") {
    try {
      const initialResult = await executeSavedViewSource(authContext, state.base.id, state.route.activeView.id, {
        maxRows: 500,
        pageSize: 100,
        operation: "initial-preview",
        surface: "ssr",
        ...(state.route.initialCursor ? { cursor: state.route.initialCursor } : {}),
      });
      return { ...state, route: { ...state.route, initialResult } } as T;
    } catch {
      return {
        ...state,
        route: {
          ...state.route,
          initialResult: {
            ok: false,
            diagnostics: [{ message: apiMessages(authContext).savedViewExecutionFailed }],
          },
        },
      } as T;
    }
  }
  if (state.route.kind !== "query" || !state.route.initialQuery.trim()) return state;
  try {
    const currentSource = currentSourceForPreview(state.route.currentSource);
    const result = await executeGqlSource(
      authContext,
      state.base.id,
      {
        query: state.route.initialQuery,
        pageSize: 100,
        ...(state.route.initialCursor ? { cursor: state.route.initialCursor } : {}),
        ...(currentSource ? { currentSource } : {}),
        surface: "ssr",
      },
      { maxRows: 10_000, operation: "initial-preview" },
    );
    return { ...state, route: { ...state.route, initialPreview: result.response } } as T;
  } catch {
    return {
      ...state,
      route: {
        ...state.route,
        initialPreview: {
          ok: false,
          diagnostics: [{ message: apiMessages(authContext).queryExecutionFailed }],
        },
      },
    } as T;
  }
};
