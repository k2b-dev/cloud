import { type AccessDialogProps, type FoundServiceAccount, openAccessDialog } from "@k2b/cloud/access/ui";
import { coreClient } from "@k2b/cloud/clients/core";
import type { AccessEntry, Principal } from "@k2b/cloud/contracts";
import { Button, InlineGuidance, NoticeCard } from "@k2b/ui";
import { createResource, For, Show } from "solid-js";
import type { artifactClient } from "./client";
import { PUBLIC_APP_SHARING } from "./contracts";
import { MachinePermissions } from "./MachinePermissions";
import { artifactMessages } from "./messages";
import { runnerHref } from "./runner-contracts";

type StudioProjects = Awaited<ReturnType<typeof artifactClient.projects>>;

/** A Code account by its exact identifier. Core answers only someone who manages this app; names and UUIDs find nothing. */
export const findStudioServiceAccount = async (
  artifactId: string,
  handle: string,
  signal: AbortSignal,
): Promise<FoundServiceAccount | null> => {
  const response = await coreClient.accounts.entities.$get(
    {
      query: {
        search: handle.trim(),
        target_type: "assistant.app",
        target_id: artifactId,
        kinds: "service_account",
        service_account_kinds: "code",
      },
    },
    { init: { signal } },
  );
  if (!response.ok) throw new Error(response.statusText);
  const found = (await response.json()).items.find(
    (item) => item.kind === "service_account" && item.serviceAccount.kind === "code" && item.serviceAccount.handle === handle.trim(),
  );
  if (!found || found.kind !== "service_account") return null;
  return {
    principal: { type: "service_account", serviceAccountId: found.serviceAccount.id },
    display: { displayName: found.serviceAccount.name, serviceAccountKind: "code" },
    description: found.serviceAccount.description,
  };
};

export type StudioAccessOptions = {
  artifactId: string;
  title: string;
  published: boolean;
  /** Operator administration: grants run with the administrator's recovery authority. */
  administrative?: boolean;
  viewerUserId?: string;
  locale: string;
  entries: AccessEntry[];
  /** Projects whose members can use the app; loaded inside the dialog, so a failure never blocks sharing. */
  loadProjects: () => Promise<StudioProjects>;
  grant: (principal: Principal, level: "read" | "admin") => Promise<AccessEntry | null>;
  change: (id: string, level: "read" | "admin" | null) => Promise<unknown>;
  findServiceAccount?: (handle: string, signal: AbortSignal) => Promise<FoundServiceAccount | null>;
  /** The opener's lifetime: aborting it closes the dialog without sending anything still pending. */
  signal?: AbortSignal;
};

/**
 * Studio sharing in the shared access dialog, in Studio and in operator administration. Use and Manage are the app's
 * levels; Code accounts get Use like a person. Machine rights stay a Studio capability and save on their own.
 */
export const studioAccessDialogProps = (options: StudioAccessOptions): AccessDialogProps => {
  const t = artifactMessages.resolve([options.locale]).t;
  return {
    resourceName: options.title,
    subtitle: t.studioApp,
    initialEntries: options.entries,
    viewerUserId: options.viewerUserId,
    signal: options.signal,
    allowPublic: PUBLIC_APP_SHARING,
    publicWarning: t.publicAccessHelp,
    publicLink: options.published ? new URL(runnerHref(options.artifactId), location.origin).href : undefined,
    allowedLevels: (principal) =>
      principal.type === "public"
        ? [{ level: "read", label: t.use }]
        : [
            { level: "read", label: t.use },
            { level: "admin", label: t.manage },
          ],
    entryDetail: (entry) => (entry.serviceAccountKind === "code" ? entry.serviceAccountDescription : undefined),
    findServiceAccount: options.findServiceAccount ?? ((handle, signal) => findStudioServiceAccount(options.artifactId, handle, signal)),
    grantAccess: async (principal, level) => {
      if (level === "write") throw new Error(t.INVALID_INPUT);
      const entry = await options.grant(principal, level);
      if (!entry) throw new Error(t.REQUEST_FAILED);
      return entry;
    },
    updateAccess: async (id, level) => {
      if (level === "write") throw new Error(t.INVALID_INPUT);
      await options.change(id, level);
    },
    revokeAccess: async (id) => {
      await options.change(id, null);
    },
    // A getter, so the sections are built inside the dialog and their requests end when it closes.
    get extraSections() {
      return <StudioAccessNotes {...options} />;
    },
  };
};

/** Opens Studio sharing. Resolves `true` when changes were saved. */
export const openStudioAccess = (options: StudioAccessOptions) => openAccessDialog(studioAccessDialogProps(options));

/** What the access list alone does not say: how the app reaches Cloud, projects, public links, and machine rights. */
export function StudioAccessNotes(props: StudioAccessOptions) {
  const t = () => artifactMessages.resolve([props.locale]).t;
  const [projects, { refetch }] = createResource(() => props.loadProjects());
  return (
    <div class="flex flex-col gap-3">
      <NoticeCard tone="info" title={t().sharedCodeTitle} detail={t().sharedCodeHelp} />
      <Show when={!props.published}>
        <NoticeCard tone="warning" title={t().unpublishedAccess} detail={t().unpublishedAccessHelp} />
      </Show>
      <Show when={!PUBLIC_APP_SHARING && props.entries.some((entry) => entry.principal.type === "public")}>
        <NoticeCard tone="warning" title={t().publicSharingOffTitle} detail={t().publicSharingOffHelp} />
      </Show>
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
            <For each={projects()}>{(project) => <li>{project.name ?? t().inaccessibleProject}</li>}</For>
          </ul>
        </NoticeCard>
      </Show>
      <MachinePermissions artifactId={props.artifactId} administrative={props.administrative} />
    </div>
  );
}
