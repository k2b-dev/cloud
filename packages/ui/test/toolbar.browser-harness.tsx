import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Button } from "../src/actions/Button";
import { Dropdown } from "../src/actions/Dropdown";
import { Toolbar, type ToolbarActionProps, type ToolbarProps } from "../src/actions/Toolbar";

render(
  () => (
    <>
      <button type="button" id="before">
        Before
      </button>
      <Toolbar label="Horizontal">
        <Button id="first">First</Button>
        <Toolbar.Group class="hidden-group">
          <Button id="hidden">Hidden</Button>
        </Toolbar.Group>
        <Button id="disabled" disabled>
          Disabled
        </Button>
        <Button id="unavailable" aria-disabled="true">
          Unavailable
        </Button>
        <Dropdown.Root items={[{ label: "Menu action", action: () => {} }]}>
          <Dropdown.Trigger id="menu" label="Menu">
            Menu
          </Dropdown.Trigger>
        </Dropdown.Root>
        <Button id="last">Last</Button>
      </Toolbar>
      <button type="button" id="after">
        After
      </button>
      <Toolbar label="Vertical" orientation="vertical">
        <Button id="top">Top</Button>
        <Button id="bottom">Bottom</Button>
      </Toolbar>
      <button type="button" id="fields-before">
        Before fields
      </button>
      <Toolbar label="Fields">
        <Button id="field-first">First action</Button>
        <input id="text" aria-label="Text" />
        <textarea id="textarea" aria-label="Textarea" />
        <select id="select" aria-label="Select">
          <option>One</option>
        </select>
        <span id="editable" contentEditable tabIndex={0}>
          Editable
        </span>
        <input id="range" aria-label="Range" type="range" min="0" max="10" value="5" />
        <input id="radio" aria-label="Radio" type="radio" />
        <input id="checkbox" aria-label="Checkbox" type="checkbox" />
        <Button id="field-last">Last action</Button>
      </Toolbar>
      <button type="button" id="fields-after">
        After fields
      </button>
      <button type="button" id="hidden-before">
        Before hidden toolbar
      </button>
      <div id="hidden-ancestor" class="hidden-ancestor">
        <Toolbar label="Initially hidden">
          <Button id="revealed-first">First revealed action</Button>
          <Button id="revealed-last">Last revealed action</Button>
        </Toolbar>
      </div>
    </>
  ),
  document.getElementById("root")!,
);

// Separate mount keeps the existing keyboard fixtures and their tab order intact.
const floatingHost = document.createElement("div");
floatingHost.id = "floating-host";
// Pinned to the viewport's top, so the whole column is on screen and the strip sits at the column's bottom.
floatingHost.style.cssText = "position: fixed; top: 0; left: 0; z-index: 1; background: white";
document.body.append(floatingHost);
const clicked: string[] = [];
type LayoutOptions = Pick<ToolbarProps, "variant">;
const [layout, setLayout] = createSignal<LayoutOptions>({ variant: "floating" });
const [overrides, setOverrides] = createSignal<Record<string, Partial<ToolbarActionProps>>>({});
let disposeFloating: (() => void) | undefined;

const selectionActions = [
  { label: "Reply", icon: "ti ti-arrow-back-up", priority: 2, keys: "r" },
  { label: "Forward", icon: "ti ti-arrow-forward-up", priority: 7, keys: "f" },
  { label: "Archive", icon: "ti ti-archive", priority: 1, keys: "e" },
  { label: "Later", icon: "ti ti-clock", priority: 3, keys: "h" },
  { label: "Move", icon: "ti ti-folder", priority: 4, keys: "v" },
  { label: "Delete", icon: "ti ti-trash", priority: 6, keys: "delete" },
  { label: "Assistant", icon: "ti ti-sparkles", priority: 5, keys: "mod+j" },
];

const mountFloating = (width = 575, hidden = false, options: LayoutOptions = { variant: "floating" }) => {
  disposeFloating?.();
  clicked.length = 0;
  setLayout(options);
  setOverrides({});
  floatingHost.style.display = hidden ? "none" : "block";
  disposeFloating = render(
    () => (
      <>
        <button type="button" id="floating-before">
          Before selection
        </button>
        <div
          id="selection-column"
          style={{ display: "flex", "flex-direction": "column", width: `${width}px`, "max-width": "100%", height: "600px" }}
        >
          <div>Inbox</div>
          <div
            id="selection-scroll"
            role="region"
            tabIndex={0}
            aria-label="Messages"
            style={{ flex: "1", "min-height": "0", overflow: "auto" }}
          >
            {Array.from({ length: 30 }, (_, index) => (
              <div class="selection-row" style={{ height: "44px" }}>
                Message {index + 1}
              </div>
            ))}
          </div>
          <Toolbar label="Selection actions" {...layout()}>
            <Toolbar.Label>3 selected</Toolbar.Label>
            <Toolbar.Group label="Respond">
              {selectionActions.slice(0, 2).map((action) => (
                <Toolbar.Action {...action} onClick={() => clicked.push(action.label)} {...overrides()[action.label]} />
              ))}
            </Toolbar.Group>
            <Toolbar.Separator />
            {selectionActions.slice(2).map((action) => (
              <Toolbar.Action {...action} onClick={() => clicked.push(action.label)} {...overrides()[action.label]} />
            ))}
            <Toolbar.Separator />
            <Toolbar.Action label="Done" icon="ti ti-check" keys="escape" onClick={() => clicked.push("Done")} />
          </Toolbar>
        </div>
        <button type="button" id="floating-after">
          After selection
        </button>
      </>
    ),
    floatingHost,
  );
};

declare global {
  interface Window {
    toolbarFixture: {
      mount: typeof mountFloating;
      resize: (width: number) => void;
      show: () => void;
      clicked: string[];
      override: (label: string, props: Partial<ToolbarActionProps>) => void;
    };
  }
}
window.toolbarFixture = {
  mount: mountFloating,
  resize: (width) => {
    document.getElementById("selection-column")!.style.width = `${width}px`;
  },
  show: () => {
    floatingHost.style.display = "block";
  },
  clicked,
  override: (label, props) => setOverrides((previous) => ({ ...previous, [label]: { ...previous[label], ...props } })),
};
