import { CloudAvatar, openProfilePictureDialog } from "@k2b/cloud/account/ui";
import { apiClient } from "@k2b/cloud/clients/core";
import { AvatarStateSchema, SaveServiceAccountAvatarSchema } from "@k2b/cloud/contracts/profile";
import { refreshCurrentPath } from "@k2b/ssr/nav";
import { useAccountsMessages } from "../messages";

type Props = { id: string; name: string; avatarHash: string | null };

/** The agent's picture at the top of its page; a click opens "Change profile picture" with photo and robot. */
export default function AgentPictureTrigger(props: Props) {
  const messages = useAccountsMessages();
  const route = () => apiClient.admin.identity["service-accounts"][":id"].avatar;
  const read = async (response: { ok: boolean; json: () => Promise<unknown> }) => {
    if (!response.ok) throw new Error(messages().agentPictureFailed);
    return AvatarStateSchema.parse(await response.json());
  };
  const change = async () => {
    const param = { id: props.id };
    const changed = await openProfilePictureDialog({
      subject: "agent",
      name: props.name,
      load: async () => read(await route().$get({ param })),
      save: async (next) => read(await route().$put({ param, json: SaveServiceAccountAvatarSchema.parse(next) })),
      deletePhoto: async () => read(await route().$delete({ param })),
    });
    if (changed) await refreshCurrentPath();
  };
  return (
    <button
      type="button"
      class="group relative shrink-0 rounded-[28%] focus-visible:outline-[length:var(--k2b-focus-width)] focus-visible:outline-solid focus-visible:outline-[var(--k2b-focus-ring)] focus-visible:outline-offset-[var(--k2b-focus-offset)]"
      aria-label={messages().agentChangePicture}
      aria-haspopup="dialog"
      title={messages().agentChangePicture}
      onClick={() => void change()}
    >
      <CloudAvatar username={props.name} userId={props.id} avatarHash={props.avatarHash} kind="service_account" size="lg" />
      <span
        class="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--ui-surface)] text-secondary shadow-[var(--ui-shadow-surface)] group-hover:text-primary group-focus-visible:text-primary"
        aria-hidden="true"
      >
        <i class="ti ti-pencil text-xs" />
      </span>
    </button>
  );
}
