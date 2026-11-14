import { PrincipalPicker } from "@k2b/cloud/access/ui";
import { useLocale } from "@k2b/ui";
import { codeAreaHref } from "./area";
import { codeAdminMessages } from "./messages";

/** Search a group to add rules for, or a person to see the effective table; choosing opens it in the detail level. */
export default function CodePolicyPicker(props: { kind: "group" | "person"; existing: string[] }) {
  const locale = useLocale();
  const t = () => codeAdminMessages.resolve([locale()]).t;
  return (
    <PrincipalPicker
      kinds={[props.kind === "group" ? "group" : "user"]}
      allowPublic={false}
      allowAuthenticated={false}
      allowServiceAccounts={false}
      placeholder={props.kind === "group" ? t().searchGroup : t().searchPerson}
      existing={props.existing.map((id) => (props.kind === "group" ? { type: "group", groupId: id } : { type: "user", userId: id }))}
      onSelect={(principal) => {
        const id = principal.type === "group" ? principal.groupId : principal.type === "user" ? principal.userId : null;
        if (id) window.location.assign(codeAreaHref({ sec: props.kind === "group" ? "groups" : "effective", id }));
      }}
    />
  );
}
