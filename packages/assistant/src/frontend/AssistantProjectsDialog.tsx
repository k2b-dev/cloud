import { prompts, toast } from "@k2b/ui";
import type { AiProject } from "@valentinkolb/cloud/ai";
import { coreClient } from "@valentinkolb/cloud/clients/core";
import { assistantBrowserText } from "./ui-copy";

const readError = async (response: Response, fallback: string): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === "string" ? body.message : fallback;
};

export const openAssistantCreateProjectDialog = async (): Promise<AiProject | null> => {
  const text = assistantBrowserText;
  const values = await prompts.form({
    title: text("Create Project"),
    icon: "ti ti-folder-plus",
    confirmText: text("Create Project"),
    fields: {
      name: {
        type: "text",
        label: text("Name"),
        placeholder: "IT support",
        required: true,
        maxLength: 120,
      },
      instructions: {
        type: "text",
        label: text("Instructions"),
        placeholder: text("How should Assistant work in this Project?"),
        multiline: true,
        lines: 5,
        maxLength: 16_000,
      },
    },
  });
  if (!values) return null;

  const response = await coreClient.ai.projects.$post({
    json: {
      name: values.name.trim(),
      instructions: values.instructions?.trim() ?? "",
      description: "",
      icon: "ti ti-folders",
    },
  });
  if (!response.ok) {
    await prompts.error(await readError(response, text("Failed to create Project")), { title: text("Could not create Project") });
    return null;
  }

  const project = (await response.json()).project as AiProject;
  toast.success(text("Project created"));
  return project;
};
