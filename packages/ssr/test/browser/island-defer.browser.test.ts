import { afterEach, expect, test } from "bun:test";
import { toJSON } from "seroval";
import { disposeIslands, islandsPending, mount } from "../../src/mount";

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  disposeIslands(document);
  document.body.replaceChildren();
});
const wrapper = () => {
  const element = document.createElement("solid-island");
  element.dataset.id = "deferred";
  element.dataset.props = JSON.stringify(toJSON({}));
  element.innerHTML = '<svg aria-label="Server chart"><path d="M0 0L10 10"></path></svg>';
  document.body.append(element);
  return element;
};
const defer = () => {
  let resume: (() => void) | undefined;
  const handler = (event: WindowEventMap["ssr:before-island-mount"]) => {
    event.preventDefault();
    resume = event.detail.resume;
  };
  window.addEventListener("ssr:before-island-mount", handler);
  stop = () => window.removeEventListener("ssr:before-island-mount", handler);
  return () => {
    if (!resume) throw new Error("Expected a deferred mount");
    resume();
  };
};

test("deferred mounts retain server markup and count as pending until a single resume", () => {
  const element = wrapper();
  const html = element.innerHTML;
  const resume = defer();
  let renders = 0;
  mount(() => {
    renders++;
    resume();
    return document.createTextNode("Interactive chart");
  }, 'solid-island[data-id="deferred"]');
  expect(element.innerHTML).toBe(html);
  expect(renders).toBe(0);
  expect(islandsPending(document)).toBe(true);
  resume();
  expect(element.textContent).toBe("Interactive chart");
  expect(islandsPending(document)).toBe(false);
  resume();
  expect(renders).toBe(1);
});

test("disposal cancels a deferred resume before a replacement page mounts", () => {
  const element = wrapper();
  const resume = defer();
  let renders = 0;
  mount(() => {
    renders++;
    return null;
  }, 'solid-island[data-id="deferred"]');
  disposeIslands(element);
  element.remove();
  resume();
  expect(renders).toBe(0);
  expect(islandsPending(document)).toBe(false);
});

test("without a deferral islands still mount synchronously", () => {
  const element = wrapper();
  mount(() => document.createTextNode("Mounted"), 'solid-island[data-id="deferred"]');
  expect(element.textContent).toBe("Mounted");
  expect(islandsPending(document)).toBe(false);
});

test("an old resume cannot start a new deferred mount of the same wrapper", () => {
  const element = wrapper();
  const oldResume = defer();
  let renders = 0;
  const component = () => {
    renders++;
    return document.createTextNode("Current chart");
  };
  mount(component, 'solid-island[data-id="deferred"]');
  stop?.();
  disposeIslands(element);
  const currentResume = defer();
  mount(component, 'solid-island[data-id="deferred"]');
  oldResume();
  expect(renders).toBe(0);
  expect(islandsPending(document)).toBe(true);
  currentResume();
  expect(element.textContent).toBe("Current chart");
  expect(renders).toBe(1);
  expect(islandsPending(document)).toBe(false);
});
