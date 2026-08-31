import { type AssistantLaunch, type LaunchAssistantInput, launchAssistant } from "@valentinkolb/cloud/ai/browser";
import { buildNoteUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";

const notebookEditTools: NonNullable<LaunchAssistantInput["preloadTools"]> = [
  { name: "text_editor" },
  { appId: "notebooks", kind: "query", id: "note.read" },
  { appId: "notebooks", kind: "query", id: "comment.list" },
  { appId: "notebooks", kind: "action", id: "note.edit" },
];

export const launchNotebookNoteAssistant = async (input: {
  notebookId: string;
  noteId: string;
  noteTitle: string;
}): Promise<AssistantLaunch> => {
  const locale = typeof document === "undefined" ? "en" : document.documentElement.lang;
  const messages = notebookWorkspaceMessages.resolve([locale]).t;
  const title = input.noteTitle.trim();

  return launchAssistant({
    launchedByAppId: "notebooks",
    title: title || messages.editWithAi,
    draft: {
      content: [
        { type: "text", text: messages.assistantEditPrompt },
        {
          type: "resource",
          ref: { type: "notebooks.note", id: input.noteId },
          title: title || messages.untitled,
          icon: "ti ti-file-text",
          href: buildNoteUrl(input.notebookId, input.noteId),
        },
      ],
    },
    preloadTools: notebookEditTools,
  });
};
