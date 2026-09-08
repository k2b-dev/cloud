import { expect, test } from "bun:test";
import { getK2bPortalRoot } from "../src/internal/portal";
import { createDomTestHarness } from "./dom";

test("portals inherit an existing body UI scope without resetting its theme", () => {
  const dom = createDomTestHarness();
  try {
    dom.document.body.classList.add("k2b-ui");
    dom.document.body.dataset.theme = "dark";
    const portal = getK2bPortalRoot(dom.document.body);
    expect(portal.parentElement).toBe(dom.document.body);
    expect(portal.classList.contains("k2b-ui")).toBe(false);
    expect(getK2bPortalRoot(dom.document.body)).toBe(portal);
  } finally {
    dom.cleanup();
  }
});

test("portals supply a UI scope when the body has none", () => {
  const dom = createDomTestHarness();
  try {
    expect(getK2bPortalRoot(dom.document.body).classList.contains("k2b-ui")).toBe(true);
  } finally {
    dom.cleanup();
  }
});
