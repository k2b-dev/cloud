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
