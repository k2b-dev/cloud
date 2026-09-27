import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../../ui/test/dom";

// A value no rule uses, so a padding that equals it can only come from the token.
const section = "13px";

const runnerPadding = async (width: number) => {
  const dom = createDomTestHarness();
  try {
    dom.window.happyDOM.setViewport({ width, height: 800 });
    const style = document.createElement("style");
    style.textContent = `:root { --ui-space-section: ${section}; }\n${await Bun.file(new URL("../styles/app.css", import.meta.url)).text()}`;
    document.head.append(style);
    // The signed-in page places the runner in the Cloud shell; the public page wraps it in its own main.
    dom.root.innerHTML = `<section class="assistant-standalone-runner"></section>
      <main class="assistant-standalone-page"><section class="assistant-standalone-runner"></section></main>`;
    const [shell, page] = Array.from(
      dom.root.querySelectorAll(".assistant-standalone-runner"),
      (runner) => getComputedStyle(runner).padding,
    );
    return { shell, page };
  } finally {
    dom.cleanup();
  }
};

test("the Cloud shell frames the signed-in runner from lg while the public page and mobile shell keep its inset", async () => {
  for (const width of [390, 1023]) expect(await runnerPadding(width)).toEqual({ shell: section, page: section });
  for (const width of [1024, 1440]) expect(await runnerPadding(width)).toEqual({ shell: "0px", page: section });
});
