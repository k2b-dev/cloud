import { PermissionEditor } from "@k2b/cloud/access/ui";
import type { AccessEntry, Principal } from "@k2b/cloud/contracts";
import { Button, InlineGuidance, NoticeCard, useLocale } from "@k2b/ui";
import { createResource, createSignal, For, Show } from "solid-js";
import type { artifactClient } from "./client";
import { artifactMessages } from "./messages";

/** The same public-access contract in Studio and operator administration. */
export function StudioPermissions(props: {
  entries: AccessEntry[];
  loadProjects: () => ReturnType<typeof artifactClient.projects>;
  grant: (principal: Exclude<Principal, { type: "service_account" }>, level: "read" | "admin") => Promise<AccessEntry | null>;
  change: (id: string, level: "read" | "admin" | null) => Promise<unknown>;
}) {
  const locale = useLocale(),
    t = () => artifactMessages.resolve([locale()]).t;
  const [publicIds, setPublicIds] = createSignal(props.entries.filter((e) => e.principal.type === "public").map((e) => e.id));
  const [addingPublic, setAddingPublic] = createSignal(false);
  const [projects, { refetch }] = createResource(props.loadProjects);
  return (
    <div class="flex flex-col gap-3">
      <Show when={projects.loading}>
        <InlineGuidance loading>{t().loading}</InlineGuidance>
      </Show>
      <Show when={projects.error}>
        <InlineGuidance tone="danger">
          {t().loadFailed}
          <Button size="sm" variant="ghost" onClick={() => void refetch()}>
            {t().retry}
          </Button>
        </InlineGuidance>
      </Show>
      <Show when={!projects.error && projects()?.length}>
        <NoticeCard tone="info" title={t().projectAccessTitle} detail={t().projectScriptsHelp}>
          <ul class="flex flex-col gap-1">
            <For each={projects()}>
              {(project) => (
                <li class="flex items-center gap-2 text-sm">
                  <i class="ti ti-folders" aria-hidden="true" />
                  {project.name ?? t().inaccessibleProject}
                </li>
              )}
            </For>
          </ul>
        </NoticeCard>
      </Show>
      <Show when={addingPublic() || publicIds().length}>
        <NoticeCard tone="warning" title={t().publicAccessTitle} detail={t().publicAccessHelp} />
      </Show>
      <PermissionEditor
        initialEntries={props.entries}
        canEdit
        allowPublic
        allowServiceAccounts={false}
        allowedLevels={(principal) =>
          principal.type === "public"
            ? [{ level: "read", label: t().use }]
            : [
                { level: "read", label: t().use },
                { level: "admin", label: t().manage },
              ]
        }
        grantAccess={async (principal, level) => {
          if (principal.type === "service_account" || level === "write" || (principal.type === "public" && level !== "read"))
            throw new Error(t().INVALID_INPUT);
          setAddingPublic(principal.type === "public");
          try {
            const entry = await props.grant(principal, level);
            if (!entry) throw new Error(t().REQUEST_FAILED);
            if (principal.type === "public") setPublicIds((ids) => [...ids, entry.id]);
            return entry;
          } finally {
            setAddingPublic(false);
          }
        }}
        updateAccess={async (id, level) => {
          if (level === "write" || (publicIds().includes(id) && level !== "read")) throw new Error(t().INVALID_INPUT);
          await props.change(id, level);
        }}
        revokeAccess={async (id) => {
          await props.change(id, null);
          setPublicIds((ids) => ids.filter((value) => value !== id));
        }}
      />
    </div>
  );
}
