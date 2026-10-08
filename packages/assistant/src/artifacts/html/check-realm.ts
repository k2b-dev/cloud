// Host-owned inspection runs in the app realm because isolated nested frames
// are not consistently exposed by Playwright. Only the host can request it.
import axe from "axe-core";
import { z } from "zod";
import { CheckTarget, matchTarget } from "./check-contracts";
import { misalignedRows, shownProblems } from "./check-layout";

// axe 4.11 ships this runtime API but omits it from its public Aria declaration.
// Describe that exact dependency surface instead of casting away the type.
declare module "axe-core" {
  interface Aria {
    getRole(node: Element): string | null;
  }
}
const Request = z.object({
  op: z.enum(["locate", "focus", "set", "select", "upload", "measure", "shown", "axe", "aria", "settle"]),
  target: CheckTarget.optional(),
  value: z.string().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  data: z.string().optional(),
});
export type CheckCommand = z.infer<typeof Request>;
const visible = (el: Element) => {
  if (el.closest('[hidden], [aria-hidden="true"]')) return false;
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement && !parent.open && !parent.querySelector(":scope > summary")?.contains(el)) return false;
  }
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none";
};
function withAxe<T>(inspect: () => T): T {
  const placeholders = [...document.querySelectorAll("[placeholder]")].map((el) => ({ el, value: el.getAttribute("placeholder")! }));
  for (const { el } of placeholders) el.removeAttribute("placeholder");
  axe.setup(document);
  try {
    return inspect();
  } finally {
    axe.teardown();
    for (const { el, value } of placeholders) el.setAttribute("placeholder", value);
  }
}
const accessibleName = (el: Element) => axe.commons.text.accessibleText(el).trim().replace(/\s+/g, " ");
const visibleText = (el: Element) => (el instanceof HTMLElement ? el.innerText : (el.textContent ?? "")).trim().replace(/\s+/g, " ");
function locate(target: z.infer<typeof CheckTarget> | undefined) {
  if (!target) throw new Error("A target is required");
  return withAxe(() => {
    const candidates = [...document.body.querySelectorAll("*")].filter(visible).filter((el) => {
      if ("role" in target) return axe.commons.aria.getRole(el) === target.role;
      if ("label" in target) return el.matches("input,textarea,select,button,[role]");
      // Prefer the innermost text carrier, so ancestors do not create duplicates.
      return ![...el.children].some((child) => visible(child) && visibleText(child) === visibleText(el));
    });
    const names = candidates.map((el) => ("text" in target ? visibleText(el) : accessibleName(el)));
    return candidates[matchTarget(names, "text" in target ? target.text : "label" in target ? target.label : target.name)]!;
  });
}
const identity = (el: Element) => {
  const name = (accessibleName(el) || visibleText(el)).slice(0, 40);
  return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${name ? " " + JSON.stringify(name) : ""}`;
};
const directText = (node: Element) =>
  [...node.childNodes]
    .filter((child) => child.nodeType === Node.TEXT_NODE)
    .map((child) => child.textContent ?? "")
    .join(" ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 100);
export async function inspectApp(raw: unknown, settle: () => Promise<void>) {
  const input = Request.parse(raw);
  if (input.op === "settle") {
    await settle();
    return null;
  }
  // Cheap enough to run after every step: a caught error shown in the page may be gone by the end.
  if (input.op === "shown") return shownProblems(document.body.innerText);
  if (input.op === "axe") {
    const results = await axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"], resultTypes: ["violations"] });
    return results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      count: v.nodes.length,
      target: String(v.nodes[0]?.target?.[0] ?? ""),
    }));
  }
  if (input.op === "aria") {
    return withAxe(() => {
      const lines: string[] = [];
      let length = 0;
      const walk = (node: Element, depth: number) => {
        if (length > 4096 || depth > 12 || !visible(node)) return;
        const role = axe.commons.aria.getRole(node);
        let line = "";
        if (role && !["generic", "presentation", "none", "paragraph"].includes(role)) {
          // Container names repeat their children's text; the children carry it.
          const name =
            (["document", "main", "list", "listitem", "row", "table", "rowgroup"].includes(role)
              ? ""
              : accessibleName(node).slice(0, 100)) || directText(node);
          const states = ["pressed", "current", "expanded", "checked", "selected", "disabled"].flatMap((state) => {
            const attr = node.getAttribute(`aria-${state}`);
            const native =
              state === "expanded" && node.matches("summary") && node.parentElement instanceof HTMLDetailsElement
                ? String(node.parentElement.open)
                : state === "checked" && node instanceof HTMLInputElement && (node.type === "checkbox" || node.type === "radio")
                  ? String(node.checked)
                  : state === "selected" && node instanceof HTMLOptionElement
                    ? String(node.selected)
                    : state === "disabled" && node.matches(":disabled")
                      ? "true"
                      : null;
            return attr !== null || native !== null ? [`${state}=${attr ?? native}`] : [];
          });
          line = `${"  ".repeat(depth)}- ${role}${name ? " " + JSON.stringify(name) : ""}${states.length ? " [" + states.join(", ") + "]" : ""}`;
          if (role === "alert" || role === "status") line += " " + (node.textContent ?? "").trim().slice(0, 200);
        } else if (!(node instanceof HTMLLabelElement)) {
          // Direct text only; a label's text is already the name of its control.
          const text = directText(node);
          if (text) line = `${"  ".repeat(depth)}${text.slice(0, 100)}`;
        }
        if (line) {
          lines.push(line);
          length += line.length;
        }
        for (const child of node.children) walk(child, Math.min(depth + (line ? 1 : 0), 12));
      };
      walk(document.body, 0);
      return lines.join("\n");
    });
  }
  if (input.op === "measure")
    return withAxe(() => {
      scrollTo(0, 0);
      const all = [...document.body.querySelectorAll("*")].filter(visible);
      for (const el of all) if (el.scrollLeft) el.scrollLeft = 0;
      const controls = all.filter((el) => el.matches('button,a[href],input,select,textarea,[role="button"],[role="link"]'));
      const clipped = controls
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          for (let p = el.parentElement; p; p = p.parentElement) {
            if (p.scrollWidth <= p.clientWidth + 1 || !["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(p).overflowX))
              continue;
            const box = p.getBoundingClientRect();
            if (rect.left < box.left - 1 || rect.right > box.right + 1) return true;
          }
          return false;
        })
        .map(identity)
        .slice(0, 20);
      const scrolling = document.scrollingElement ?? document.documentElement;
      return {
        height: Math.ceil(document.documentElement.getBoundingClientRect().height),
        empty: !document.body.innerText.trim() && !all.some((el) => el.matches("svg,canvas,img,input,button")),
        overflowX: scrolling.scrollWidth > scrolling.clientWidth + 1,
        wide: all
          .filter((el) => el.getBoundingClientRect().right > scrolling.clientWidth + 1 || el.getBoundingClientRect().left < -1)
          .slice(0, 10)
          .map(identity),
        clipped,
        invalid: all
          .filter((el) => el.matches(":user-invalid"))
          .map(identity)
          .slice(0, 20),
        interactive: controls.some((el) => !el.matches('a[href],[role="link"]')),
        password: !!document.querySelector('input[type="password"]'),
        layout: [...misalignedRows(document.body), ...shownProblems(document.body.innerText)],
        untyped: [...document.forms].some((form) => form.querySelectorAll("button:not([type])").length > 1),
      };
    });
  const el = locate(input.target);
  if (el.matches(":disabled")) throw new Error("Target is disabled");
  if (input.op === "focus") {
    if (!(el instanceof HTMLElement || el instanceof SVGElement)) throw new Error("Target cannot receive focus");
    el.focus();
    return true;
  }
  el.scrollIntoView({ block: "center", inline: "nearest" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (input.op === "locate") {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) throw new Error("Target has no visible area");
    return {
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      checked: el instanceof HTMLInputElement && el.checked,
      type: el instanceof HTMLInputElement ? el.type : "",
    };
  }
  if (input.op === "set") {
    if (!(el instanceof HTMLInputElement)) throw new Error("Fill needs an input");
    el.focus();
    el.value = input.value ?? "";
    if (el.value !== input.value) throw new Error(`Input does not accept ${JSON.stringify(input.value)}`);
  } else if (input.op === "select") {
    if (!(el instanceof HTMLSelectElement)) throw new Error("Select needs a select element");
    const options = [...el.options];
    const selected =
      options.find((option) => option.value === input.value) ??
      options[
        matchTarget(
          options.map((option) => option.label),
          input.value,
        )
      ];
    el.value = selected!.value;
  } else if (input.op === "upload") {
    if (!(el instanceof HTMLInputElement) || el.type !== "file") throw new Error("Upload needs a file input");
    const data = Uint8Array.from(atob(input.data ?? ""), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], input.name ?? "input", { type: input.type }));
    el.files = transfer.files;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}
