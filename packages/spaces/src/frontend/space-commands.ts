import { consumeCommandLink, registerCommandHandler } from "@k2b/cloud/browser/commands";
import { invokeCapabilityWithDataSchema, listCapabilityCatalog } from "@k2b/cloud/capabilities";
import { resolveCapabilityResourceReader, type CloudResourceRef } from "@k2b/cloud/contracts";
import { type DateContext } from "@k2b/stdlib";
import { prompts, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount } from "solid-js";
import { z } from "zod";
import { apiClient } from "../api/client";
import { SpaceBrowseDataSchema } from "../capability-contracts";
import { SpaceComposeInputSchema, spaceCommandMessages } from "../commands";
import type { SpaceDetail, SpaceItemResourceReferenceInput } from "../contracts";
import { createItemController } from "./[id]/_components/sidebar/CreateItemButton";

export const createSpaceCommands = (options: { current?: () => SpaceDetail | undefined; dateConfig?: DateContext }) => {
  const locale = useLocale();
  const t = () => spaceCommandMessages.resolve([locale()]).t;
  const [space, setSpace] = createSignal<SpaceDetail>();
  const controller = createItemController({
    get spaceId() {
      return space()?.id ?? "";
    },
    get columns() {
      return space()?.columns ?? [];
    },
    get tags() {
      return space()?.tags ?? [];
    },
    dateConfig: options.dateConfig,
  });
  let pending = false;
  let active = true;
  const abort = new AbortController();
  onCleanup(() => {
    active = false;
    abort.abort();
  });
  const sourceReference = async (ref: CloudResourceRef): Promise<SpaceItemResourceReferenceInput> => {
    let cursor: string | undefined;
    do {
      const catalog = await listCapabilityCatalog({ cursor, limit: 25, signal: abort.signal });
      if (!catalog.ok) throw new Error(t().sourceUnavailable);
      const app = catalog.data.apps.find((app) => ref.type.startsWith(`${app.appId}.`));
      if (app) {
        const reader = resolveCapabilityResourceReader(app.manifest, ref);
        if (!reader) break;
        const result = await invokeCapabilityWithDataSchema(
          { appId: app.appId, capabilityId: reader.localId, kind: "query", input: { id: ref.id }, signal: abort.signal },
          z.unknown(),
          { headers: { "x-cloud-locale": locale() } },
        );
        if (!result.ok) break;
        const reference = result.data.refs?.find((item) => item.type === ref.type && item.id === ref.id);
        if (!reference?.title) break;
        return { ref, label: reference.title };
      }
      const next = catalog.data.page.hasMore ? catalog.data.page.nextCursor : undefined;
      if (next && cursor && next <= cursor) break;
      cursor = next;
    } while (cursor);
    throw new Error(t().sourceUnavailable);
  };
  onMount(() => {
    for (const type of ["task", "event"] as const) {
      onCleanup(
        registerCommandHandler(
          `spaces.${type}.compose`,
          SpaceComposeInputSchema,
          async (input, commandOptions) => {
            if (pending || controller.pending()) return;
            pending = true;
            try {
              let spaceId = input.spaceId ?? options.current?.()?.id;
              if (!spaceId) {
                const choice = await prompts.search<{ id: string }>(
                  async ({ query, abortSignal }) => {
                    const result = await invokeCapabilityWithDataSchema(
                      {
                        appId: "spaces",
                        capabilityId: "space.browse",
                        kind: "query",
                        input: { query, minimumPermission: "write", limit: 100 },
                        signal: abortSignal,
                      },
                      SpaceBrowseDataSchema,
                    );
                    if (!result.ok) throw new Error(result.error.message);
                    return result.data.data.map((space) => ({ value: { id: space.id }, label: space.name, icon: "ti ti-layout-kanban" }));
                  },
                  { title: t().chooseSpace, placeholder: t().findSpace, minQueryLength: 0, noResultsText: t().noSpaces, size: "small" },
                );
                if (!choice?.value || !active) return;
                spaceId = choice.value.id;
              }
              const response = await apiClient[":id"]["settings-context"].$get(
                { param: { id: spaceId } },
                { init: { signal: abort.signal } },
              );
              if (!response.ok) throw new Error(t().failed);
              const context = await response.json();
              if (context.permission === "read") throw new Error(t().noSpaces);
              const references = input.source ? [await sourceReference(input.source)] : undefined;
              if (!active) return;
              setSpace(context.space);
              await controller.createItem({ type, references, returnTo: commandOptions.returnTo });
            } finally {
              pending = false;
            }
          },
          (input) => !input.spaceId || !options.current?.() || input.spaceId === options.current()?.id,
        ),
      );
    }
    void consumeCommandLink();
  });
};
