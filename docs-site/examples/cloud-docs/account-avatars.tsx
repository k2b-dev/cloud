import { CloudAvatar, cloudAvatarSource } from "@k2b/cloud/account/ui";
import { AvatarStack } from "@k2b/ui";

type Account = { id: string; username: string; avatarHash: string | null };

export function NoteAuthor(props: { user: Account }) {
  return (
    <>
      <CloudAvatar username={props.user.username} userId={props.user.id} avatarHash={props.user.avatarHash} size="sm" />
      <CloudAvatar username="Stock bot" kind="service_account" size="sm" />
    </>
  );
}

export function HereNow(props: { people: Account[] }) {
  return (
    <AvatarStack
      title="Here now"
      label={`Here now: ${props.people.length} people`}
      people={props.people.map((person) => ({
        id: person.id,
        name: person.username,
        src: cloudAvatarSource(person.id, person.avatarHash),
      }))}
    />
  );
}
