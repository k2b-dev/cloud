import type { PersonalGroupOwner } from "@k2b/cloud/contracts";
import { Tag } from "@k2b/ui";

type PersonalGroupTagProps = {
  owner: PersonalGroupOwner;
  label: string;
  /** Links to the owning user when the viewer may open user details. */
  linkToOwner: boolean;
};

/** Marks a personal Linux group and names the user it belongs to. */
export default function PersonalGroupTag(props: PersonalGroupTagProps) {
  const tag = <Tag icon="ti ti-user">{props.label}</Tag>;
  return props.linkToOwner ? (
    <a href={`/app/accounts/users/${encodeURIComponent(props.owner.id)}`} class="inline-flex rounded-md hover:underline">
      {tag}
    </a>
  ) : (
    tag
  );
}
