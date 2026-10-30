import { spyOn } from "bun:test";
import { discussionProviders } from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import {
  CloudResourceReaderViewSchema,
  DiscussionActivityDataSchema,
  DiscussionActivityInputSchema,
  DiscussionContainersDataSchema,
  DiscussionContainersInputSchema,
  type ResourceReadableInput,
} from "@k2b/cloud/contracts";
import { z } from "zod";
import { discussionProviderDependencies } from "./discussion-read";

export const providerApp = (appId: string, container = "collection", item = "item") => {
  const read = (contained: boolean) => ({
    title: "Read resource",
    description: "Read an authorized resource.",
    openWorld: false,
    input: z.object({ id: z.string().min(1).max(512).describe("Resource ID.") }).strict(),
    data: z
      .object({ view: contained ? CloudResourceReaderViewSchema.required({ container: true }) : CloudResourceReaderViewSchema })
      .strict(),
    run: async () => ({ ok: false as const, error: { code: "NOT_FOUND", message: "Missing", status: 404 as const } }),
  });
  return {
    appId,
    appName: appId,
    appIcon: "ti ti-box",
    appDescription: "A discussion provider.",
    manifest: compileCapabilityManifest(appId, {
      protocolVersion: 2,
      types: {
        [container]: {
          access: { readable: async ({ principals }: ResourceReadableInput) => principals },
          title: "Collection",
          description: "An item collection.",
          reader: `${container}.read`,
          icon: "ti ti-box",
          color: "blue",
        },
        [item]: {
          access: { readable: async ({ principals }: ResourceReadableInput) => principals },
          title: "Inventory item",
          description: "An item.",
          reader: `${item}.read`,
          container,
          icon: "ti ti-package",
          color: "amber",
        },
      },
      discussions: { item, containers: `${container}.containers`, activity: `${container}.activity` },
      queries: {
        [`${container}.read`]: read(false),
        [`${item}.read`]: read(true),
        [`${container}.containers`]: {
          title: "List collections",
          description: "List authorized collections.",
          openWorld: false,
          input: DiscussionContainersInputSchema,
          data: DiscussionContainersDataSchema,
          run: async () => ({ ok: true, data: { data: { items: [], next: null } } }),
        },
        [`${container}.activity`]: {
          title: "Read activity",
          description: "Read authorized activity.",
          openWorld: false,
          input: DiscussionActivityInputSchema,
          data: DiscussionActivityDataSchema,
          run: async () => ({ ok: true, data: { data: [] } }),
        },
      },
    }),
  };
};
export const mockDiscussionCatalog = (apps = [providerApp("spaces", "space", "item"), providerApp("notebooks", "notebook", "note")]) =>
  spyOn(discussionProviderDependencies, "discover").mockImplementation((caller, options) =>
    discussionProviders(
      {
        ...caller,
        authority: undefined,
        transport: async (request) => {
          const url = new URL(request.url);
          const offset = Number(url.searchParams.get("cursor")) || 0;
          const limit = Number(url.searchParams.get("limit"));
          const next = offset + limit;
          return Response.json({
            protocolVersion: 2,
            apps: apps.slice(offset, next),
            page: next < apps.length ? { hasMore: true, nextCursor: String(next) } : { hasMore: false },
          });
        },
      },
      options,
    ),
  );

/** Old domain fixtures remain useful for access scenarios; only their transport changes. */
export const standardData = (type: string, data: Record<string, unknown>) => ({
  view: {
    title: data.title ?? data.name,
    ...(typeof data.description === "string" ? { context: data.description } : {}),
    done: data.completedAt != null,
    permission: data.permission === "manage" ? "admin" : (data.permission ?? "read"),
    ...(data.spaceId || data.notebookId
      ? {
          container: {
            ref: { type: data.spaceId ? "spaces.space" : "notebooks.notebook", id: data.spaceId ?? data.notebookId },
            title: "Container",
          },
          ...(type === "spaces.item" ? { done: data.completedAt != null } : {}),
        }
      : {}),
  },
});
