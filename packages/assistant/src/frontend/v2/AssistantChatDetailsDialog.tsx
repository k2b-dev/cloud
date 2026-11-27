import type { AiConversation, AiProject } from "@k2b/cloud/ai";
import { Button, Dialog, Facts, Failed, List, Loading, Row, Section, Text, useToast } from "@k2b/ui/v2";
import { createResource, createSignal, For, Show } from "solid-js";
import { assistantApi } from "../../api/client";
import { useAssistantText } from "../ui-copy";

/** How many files the details name before they count the rest. */
const FILES_SHOWN = 5;

/**
 * The details of one chat, as v1's sidebar preview showed them: what Gustav does now, the last tool, the Project, the
 * model, the files the person brought and received. They load when the dialog opens; the pin and "Chat settings"
 * stand at its foot.
 */
export default function AssistantChatDetailsDialog(props: {
  conversation: AiConversation;
  project?: AiProject;
  onClose: () => void;
  onEdit: () => void;
  onUpdated: (conversation: AiConversation) => void;
}) {
  const text = useAssistantText();
  const toast = useToast();
  const [details, { refetch }] = createResource(
    () => props.conversation.id,
    (id) => assistantApi.loadSidebarPreview(id),
  );
  const [pinning, setPinning] = createSignal(false);
  const togglePin = async () => {
    setPinning(true);
    try {
      props.onUpdated(await assistantApi.setConversationPinned(props.conversation.id, !props.conversation.pinnedAt));
    } catch {
      toast(text("Could not update pin."), { status: "bad" });
    } finally {
      setPinning(false);
    }
  };
  const facts = () => [
    ...(props.conversation.activity?.step ? [{ label: text("Current task"), value: props.conversation.activity.step }] : []),
    ...(props.conversation.activity?.tool ? [{ label: text("Last tool"), value: props.conversation.activity.tool }] : []),
    ...(props.project ? [{ label: text("Project"), value: props.project.name }] : []),
    ...(props.conversation.isDone ? [{ label: text("Status"), value: text("Done") }] : []),
    ...(details.state === "ready" ? [{ label: text("Model"), value: details()?.model ?? text("Not used yet") }] : []),
  ];
  const fileName = (path: string) => path.split("/").pop() || path;
  return (
    <Dialog
      title={props.conversation.title}
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      foot={
        <>
          <Button icon={props.conversation.pinnedAt ? "pinned-off" : "pin"} busy={pinning()} onClick={() => void togglePin()}>
            {text(props.conversation.pinnedAt ? "Unpin chat" : "Pin chat")}
          </Button>
          <Button variant="primary" icon="settings" onClick={props.onEdit}>
            {text("Chat settings")}
          </Button>
        </>
      }
    >
      <Show when={props.conversation.description}>{(description) => <Text>{description()}</Text>}</Show>
      <Show when={facts().length > 0}>
        <Facts items={facts()} />
      </Show>
      <Show
        when={details.state !== "errored"}
        fallback={<Failed text={text("Could not load chat details.")} onRetry={() => void refetch()} />}
      >
        <Show when={details.state === "ready" ? details() : undefined} fallback={<Loading rows={2} />}>
          {(value) => (
            <Show when={value().files.length > 0}>
              <Section title={text("Files")} count={value().files.length}>
                <List label={text("Files")}>
                  <For each={value().files.slice(0, FILES_SHOWN)}>
                    {(file) => <Row icon="file" lines={[fileName(file.path)]} meta={file.path} />}
                  </For>
                </List>
                <Show when={value().files.length > FILES_SHOWN || value().hasMoreSources}>
                  <Text type="meta" muted>
                    {text("More resources in the chat.")}
                  </Text>
                </Show>
              </Section>
            </Show>
          )}
        </Show>
      </Show>
    </Dialog>
  );
}
