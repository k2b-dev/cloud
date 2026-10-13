import { render } from "solid-js/web";
import { Button } from "../src/actions/Button";
import { Dropdown } from "../src/actions/Dropdown";
import { Toolbar } from "../src/actions/Toolbar";

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
      <Toolbar label="Fields">
        <input id="text" aria-label="Text" />
        <textarea id="textarea" aria-label="Textarea" />
        <select id="select" aria-label="Select">
          <option>One</option>
        </select>
        <span id="editable" contentEditable tabIndex={0}>
          Editable
        </span>
        <input id="checkbox" aria-label="Checkbox" type="checkbox" />
      </Toolbar>
    </>
  ),
  document.getElementById("root")!,
);
