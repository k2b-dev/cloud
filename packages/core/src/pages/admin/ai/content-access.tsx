import { openAccessDialog } from "@k2b/cloud/access/ui";
import type { AiProjectAccess, AiSkillAccess } from "@k2b/cloud/ai";
import { coreClient } from "@k2b/cloud/clients/core";
import { AuthenticatedPrincipalSchema } from "@k2b/cloud/contracts";
import { Button, InlineGuidance, NoticeCard } from "@k2b/ui";
import { createSignal, For, Match, Switch } from "solid-js";
import { settingsMessages } from "../settings/_components/messages";

// k2b-ui gap: v2 has no access editor; the platform's v1 access dialog (`openAccessDialog`) stands in for Skills and
// Projects until one exists. This module holds no v2 import, so its v1 parts stay where they belong.

type SettingsMessages = ReturnType<typeof settingsMessages.resolve>["t"];
type ProjectContext = { state: "loading" } | { state: "failed" } | { state: "ready"; names: (string | null)[] };

/** The server's reason for a refused request, or the fallback. */
export const readError = async (response: Pick<Response, "json">, fallback: string): Promise<string> => {
  const body: unknown = await response.json().catch(() => null);
  const message = body && typeof body === "object" && "message" in body ? body.message : undefined;
  return typeof message === "string" && message ? message : fallback;
};

/** The projects that include the Skill: context next to the direct access, loaded on its own with a retry. */
const SkillProjects = (props: { context: () => ProjectContext; retry: () => void; t: SettingsMessages }) => (
  <Switch>
    <Match when={props.context().state === "loading"}>
      <InlineGuidance loading>{props.t.loadingSkillProjects}</InlineGuidance>
    </Match>
    <Match when={props.context().state === "failed"}>
      <InlineGuidance tone="warning" icon="ti ti-alert-triangle">
        {props.t.skillProjectsUnavailable}{" "}
        <Button size="xs" variant="text" onClick={() => props.retry()}>
          {props.t.retry}
        </Button>
      </InlineGuidance>
    </Match>
    <Match
      when={(() => {
        const context = props.context();
        return context.state === "ready" && context.names.length > 0 ? context.names : undefined;
      })()}
    >
      {(names) => (
        <NoticeCard tone="info" title={props.t.skillProjectAccessTitle} detail={props.t.skillProjectAccessHelp}>
          <ul class="flex flex-col gap-1">
            <For each={names()}>{(name) => <li>{name ?? props.t.skillProjectUnavailable}</li>}</For>
          </ul>
        </NoticeCard>
      )}
    </Match>
  </Switch>
);

/**
 * Opens who may use and manage a Skill. Resolves `true` when a change was stored (also when a later change of the same
 * save failed and the person discarded the rest), so the page reads the list again; `false` when nothing changed or the
 * page moved on while the stored entries loaded. A failure to load them throws with the reason.
 */
export const openSkillAccess = async (skill: { shortId: string; name: string }, locale: string, signal: AbortSignal) => {
  const t = settingsMessages.resolve([locale]).t;
  const api = coreClient.admin.core["ai-skills"][":skillId"];
  const response = await api.access.$get({ param: { skillId: skill.shortId } }, { init: { signal } });
  if (!response.ok) throw new Error(await readError(response, t.loadSkillPermissionsFailed));
  const initialEntries: AiSkillAccess[] = (await response.json()).access;
  // The page may have changed while the list loaded; never open the dialog over another page.
  if (signal.aborted) return false;
  // The projects are context; a slow or failed answer never holds up editing the direct access.
  const [projects, setProjects] = createSignal<ProjectContext>({ state: "loading" });
  const loadProjects = () => {
    setProjects({ state: "loading" });
    api.projects
      .$get({ param: { skillId: skill.shortId } }, { init: { signal } })
      .then(async (answer) => {
        if (!answer.ok) throw new Error(t.skillProjectsUnavailable);
        const names = (await answer.json()).projects.map((project) => project.name);
        if (!signal.aborted) setProjects({ state: "ready", names });
      })
      .catch(() => {
        if (!signal.aborted) setProjects({ state: "failed" });
      });
  };
  loadProjects();
  let wrote = false;
  await openAccessDialog({
    resourceName: skill.name,
    subtitle: t.skillAccessSubtitle,
    initialEntries,
    allowPublic: false,
    target: { type: "core.ai.skill", id: skill.shortId },
    signal,
    extraSections: <SkillProjects context={projects} retry={loadProjects} t={t} />,
    grantAccess: async (principal, permission) => {
      const answer = await api.access.$post({
        param: { skillId: skill.shortId },
        json: { principal: AuthenticatedPrincipalSchema.parse(principal), permission },
      });
      if (!answer.ok) throw new Error(await readError(answer, t.grantSkillAccessFailed));
      wrote = true;
      return (await answer.json()).access;
    },
    updateAccess: async (accessId, permission) => {
      const answer = await api.access[":accessId"].$patch({ param: { skillId: skill.shortId, accessId }, json: { permission } });
      if (!answer.ok) throw new Error(await readError(answer, t.updateSkillAccessFailed));
      wrote = true;
    },
    revokeAccess: async (accessId) => {
      const answer = await api.access[":accessId"].$delete({ param: { skillId: skill.shortId, accessId } });
      if (!answer.ok) throw new Error(await readError(answer, t.revokeSkillAccessFailed));
      wrote = true;
    },
  });
  // After navigation the page is another one; reading it again would cancel where the person went.
  return wrote && !signal.aborted;
};

/** Opens who may use and manage a Project; resolves as `openSkillAccess` does. */
export const openProjectAccess = async (project: { shortId: string; name: string }, locale: string, signal: AbortSignal) => {
  const t = settingsMessages.resolve([locale]).t;
  const api = coreClient.admin.core["ai-projects"][":projectId"];
  const response = await api.access.$get({ param: { projectId: project.shortId } }, { init: { signal } });
  if (!response.ok) throw new Error(await readError(response, t.loadProjectPermissionsFailed));
  const initialEntries: AiProjectAccess[] = (await response.json()).access;
  if (signal.aborted) return false;
  let wrote = false;
  await openAccessDialog({
    resourceName: project.name,
    subtitle: t.projectAccessSubtitle,
    initialEntries,
    allowPublic: false,
    target: { type: "core.ai.project", id: project.shortId },
    signal,
    grantAccess: async (principal, permission) => {
      const answer = await api.access.$post({
        param: { projectId: project.shortId },
        json: { principal: AuthenticatedPrincipalSchema.parse(principal), permission },
      });
      if (!answer.ok) throw new Error(await readError(answer, t.grantProjectAccessFailed));
      wrote = true;
      return (await answer.json()).access;
    },
    updateAccess: async (accessId, permission) => {
      const answer = await api.access[":accessId"].$patch({ param: { projectId: project.shortId, accessId }, json: { permission } });
      if (!answer.ok) throw new Error(await readError(answer, t.updateProjectAccessFailed));
      wrote = true;
    },
    revokeAccess: async (accessId) => {
      const answer = await api.access[":accessId"].$delete({ param: { projectId: project.shortId, accessId } });
      if (!answer.ok) throw new Error(await readError(answer, t.revokeProjectAccessFailed));
      wrote = true;
    },
  });
  return wrote && !signal.aborted;
};
