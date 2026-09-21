import type { AiProject } from "@k2b/cloud/ai";
import { assistantApi } from "../api/client";
import { AssistantProjectLinks } from "./AssistantProjectLinks";
import { useAssistantText } from "./ui-copy";

type SkillPage = Awaited<ReturnType<typeof assistantApi.projectSkills>>;
export function AssistantProjectSkills(props: { project: AiProject; initialPage: SkillPage }) {
  const text = useAssistantText();
  const page = (value: SkillPage) => ({
    ...value,
    items: value.items.map((skill) => ({
      id: skill.shortId,
      title: skill.name,
      description: skill.description,
      icon: "ti ti-wand",
      canManage: skill.permission === "admin",
    })),
  });
  return (
    <AssistantProjectLinks
      icon="ti ti-wand"
      project={props.project}
      initialPage={page(props.initialPage)}
      title={text("Skills")}
      addLabel={text("Link a Skill")}
      searchLabel={text("Search Skills…")}
      notice={text("Members can read and use linked Skills. Editing permissions stay unchanged.")}
      emptyLabel={text("No linked Skills yet.")}
      noResultsLabel={text("No matching Skills that you manage.")}
      load={async (cursor, query, available, signal) =>
        page(await assistantApi.projectSkills(props.project.id, cursor, query, available, signal))
      }
      change={(id, linked) => assistantApi.linkSkillProject(id, props.project.id, linked)}
    />
  );
}
