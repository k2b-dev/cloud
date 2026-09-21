import {
  BottomSheet,
  Button,
  bottomSheetOptions,
  confirmDiscardIfDirty,
  createNavigation,
  dialogCore,
  Navigation,
  TextInput,
} from "@k2b/ui";
import { createSignal } from "solid-js";
import { DemoCard } from "../DemoCard";

/** The host owns opening and dismissal; the same controller works inline or in a sheet. */
export function NavigationDemo() {
  const [active, setActive] = createSignal("inbox");
  const [count, setCount] = createSignal(3);
  const navigation = createNavigation({
    items: () => [
      { id: "inbox", action: "inbox", label: "Inbox", icon: "ti ti-inbox", badge: count(), active: active() === "inbox" },
      {
        id: "projects",
        label: "Projects",
        children: [
          {
            id: "work",
            action: "work",
            label: "A project with a long name that remains readable on a narrow screen",
            icon: "ti ti-folder",
            active: active() === "work",
            actions: [{ id: "rename", action: "rename", label: "Rename project", icon: "ti ti-pencil" }],
          },
          { id: "pending", action: "pending", label: "Waiting for access", disabled: true },
        ],
      },
      { id: "docs", label: "Workspace documentation", href: "/en/ui/layout/workspace", icon: "ti ti-book" },
    ],
    onAction: (action) => {
      setActive(action);
    },
  });
  const open = () =>
    dialogCore.open<void>(
      (close, context) => (
        <BottomSheet onDismiss={context.requestDismiss}>
          <BottomSheet.Header title="Workspace menu" close={() => void context.requestDismiss()} />
          <BottomSheet.Body>
            <Navigation label="Workspace" navigation={navigation} beforeSelect={() => close()} />
          </BottomSheet.Body>
          <BottomSheet.Footer>
            <Button variant="ghost" onClick={() => setCount((value) => value + 1)}>
              Simulate live update
            </Button>
          </BottomSheet.Footer>
        </BottomSheet>
      ),
      bottomSheetOptions,
    );
  return (
    <DemoCard
      id="navigation"
      chip={{ kind: "component", name: "Navigation", from: "@k2b/ui" }}
      description="One live navigation model, native links, local actions and readable nested rows. The host chooses where it renders."
      code={`const navigation = createNavigation({\n  items: () => [{ id: "inbox", label: "Inbox", action: "inbox", badge: count() }],\n  onAction: id => setActive(id),\n});\n<Navigation navigation={navigation} label="Workspace" />`}
    >
      <div class="flex flex-col gap-3 max-w-xl">
        <Button onClick={() => void open()}>Open menu sheet</Button>
        <p>Selected: {active()}</p>
        <Navigation navigation={navigation} label="Inline workspace" />
      </div>
    </DemoCard>
  );
}

export function BottomSheetDemo() {
  const open = () =>
    dialogCore.open<void>((close, context) => {
      const [name, setName] = createSignal("");
      context.setDismissHandler(async () => {
        if (await confirmDiscardIfDirty(() => name().length > 0)) close();
      });
      return (
        <BottomSheet onDismiss={context.requestDismiss}>
          <BottomSheet.Header
            title="Edit a draft"
            subtitle="Drag the handle, press Escape or use Close."
            close={() => void context.requestDismiss()}
          />
          <BottomSheet.Body>
            <TextInput label="Draft name" value={name} onValueChange={setName} />
          </BottomSheet.Body>
          <BottomSheet.Footer>
            <Button variant="secondary" onClick={() => void context.requestDismiss()}>
              Close
            </Button>
            <Button onClick={() => close()}>Save draft</Button>
          </BottomSheet.Footer>
        </BottomSheet>
      );
    }, bottomSheetOptions);
  return (
    <DemoCard
      id="bottom-sheet"
      chip={{ kind: "component", name: "BottomSheet", from: "@k2b/ui" }}
      description="A bottom-edge dialog with guarded dismissal, a touch handle, safe-area spacing and the shared focus trap. Enter a draft to exercise the discard guard."
      code={`dialogCore.open((close, context) => <BottomSheet onDismiss={context.requestDismiss}>\n  <BottomSheet.Header title="Details" close={context.requestDismiss} />\n  <BottomSheet.Body>Content</BottomSheet.Body>\n</BottomSheet>, bottomSheetOptions);`}
    >
      <Button onClick={() => void open()}>Open bottom sheet</Button>
    </DemoCard>
  );
}
