import { openSpotlightSearch } from "@k2b/ui";

type PickerProject = { id: string; name: string; description: string; icon?: string | null };
type PickerCopy = {
  chooseProjectTitle: string;
  searchProjects: string;
  noMatchingProjects: string;
  noProject: string;
  separateChat: string;
  sharedProjectContext: string;
};

/**
 * The project picker of an empty chat, loaded when someone opens it: the search dialog stays out of the workspace
 * bundle. Resolves to the chosen project ID, `null` for no project, or `undefined` when closed.
 */
export const pickEmptyChatProject = async (copy: PickerCopy, projects: () => readonly PickerProject[]) =>
  (
    await openSpotlightSearch<{ projectId: string | null }>({
      title: copy.chooseProjectTitle,
      icon: "ti ti-folder-open",
      placeholder: copy.searchProjects,
      minQueryLength: 0,
      noResultsText: copy.noMatchingProjects,
      resolve: ({ query }) => {
        const normalized = query.trim().toLocaleLowerCase();
        return [
          { value: { projectId: null }, label: copy.noProject, desc: copy.separateChat, icon: "ti ti-message-circle" },
          ...projects()
            .filter((project) => !normalized || `${project.name} ${project.description}`.toLocaleLowerCase().includes(normalized))
            .map((project) => ({
              value: { projectId: project.id },
              label: project.name,
              desc: project.description || copy.sharedProjectContext,
              icon: project.icon || "ti ti-folder",
            })),
        ];
      },
    })
  )?.value;
