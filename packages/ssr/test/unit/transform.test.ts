import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fromJSON, toJSON } from "seroval";
import { renderToString } from "solid-js/web";
import { islandIdFromFile } from "../../src/island-id";
import { transform } from "../../src/transform";
import { makeTempRoot as makeResolvableTempRoot } from "../temp-root";

const tempRoots: string[] = [];

const makeTempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "ssr-transform-test-"));
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  while (tempRoots.length) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

/** The elements and comments of rendered HTML, read by an HTML tokenizer as a browser reads them. */
const parseHtml = async (html: string) => {
  const elements: string[] = [];
  const comments: string[] = [];
  await new HTMLRewriter()
    .on("*", { element: (element) => void elements.push(element.tagName) })
    .onDocument({ comments: (comment) => void comments.push(comment.text) })
    .transform(new Response(html))
    .text();
  return { elements, comments };
};
/** The serialized props of the first island in rendered HTML. */
const propsComment = async (html: string) => (await parseHtml(html)).comments[0]?.replace(/^ssr-props:/, "");

/** Render a server page that passes `props` (a source expression) to one island. */
const renderProbe = async (props: string, preamble = "") => {
  const root = makeResolvableTempRoot(".ssr-transform-render-");
  tempRoots.push(root);
  writeFileSync(join(root, "Probe.island.tsx"), "export default (props) => props.children;");
  const filename = join(root, "Page.tsx");
  const result = await transform(
    `import Probe from "./Probe.island";\n${preamble}\nexport default () => <main><Probe {...${props}}><p>server</p></Probe></main>;`,
    filename,
    "ssr",
    false,
    root,
  );
  writeFileSync(join(root, "Page.js"), result);
  const { default: Page } = await import(join(root, "Page.js"));
  return renderToString(() => Page());
};

describe("transform() - Island wrapping in SSR mode", () => {
  test("should wrap .island imports with solid-island tag", async () => {
    const input = `
      import Counter from "./Counter.island";
      export default () => <Counter count={5} />;
    `;

    const result = await transform(input, "/test/Page.tsx", "ssr");

    expect(result).toContain("solid-island");
    expect(result).toContain("data-id");
    expect(result).toContain("<!--ssr-props:");
  });

  test("should wrap .client imports with solid-client tag", async () => {
    const input = `
      import Widget from "./Widget.client";
      export default () => <Widget />;
    `;

    const result = await transform(input, "/test/Page.tsx", "ssr");

    expect(result).toContain("solid-client");
    expect(result).toContain("data-id");
    expect(result).toContain("<!--ssr-props:");
    expect(result).not.toContain('import Widget from "./Widget.client"');
  });

  test("should NOT wrap regular imports", async () => {
    const input = `
      import Button from "./Button";
      export default () => <Button />;
    `;

    const result = await transform(input, "/test/Page.tsx", "ssr");

    expect(result).not.toContain("solid-island");
    expect(result).not.toContain("solid-client");
  });

  test("should inject seroval import and helper", async () => {
    const input = `
      import Counter from "./Counter.island";
      export default () => <Counter count={5} />;
    `;

    const result = await transform(input, "/test/Page.tsx", "ssr");

    expect(result).toContain('import { toJSON as __seroval_toJSON } from "seroval"');
    expect(result).not.toContain("const __seroval_toJSON");
  });

  test("should use __seroval_toJSON for the props comment", async () => {
    const input = `
      import Counter from "./Counter.island";
      export default () => <Counter count={5} name="test" />;
    `;

    const result = await transform(input, "/test/Page.tsx", "ssr");

    expect(result).toContain("JSON.stringify(__seroval_toJSON(");
    // Seroval already writes `<` in strings as \x3C; the comment stays closed without relying on that.
    expect(result).toContain(String.raw`.replace(/</g, "\\u003c").replace(/>/g, "\\u003e")`);
    // Should serialize the props object
    expect(result).toContain("count");
  });

  test("should generate deterministic data-id based on file path", async () => {
    const input = `
      import Counter from "./Counter.island";
      export default () => <Counter />;
    `;

    const result1 = await transform(input, "/test/Page.tsx", "ssr");
    const result2 = await transform(input, "/test/Page.tsx", "ssr");

    // Both results should contain the same 8-char hash
    // Just check they both contain "data-id" attribute
    expect(result1).toContain("data-id");
    expect(result2).toContain("data-id");

    // And that the overall structure is identical (deterministic)
    expect(result1).toBe(result2);
  });

  test("should handle multiple islands in one file", async () => {
    const input = `
      import Counter from "./Counter.island";
      import Timer from "./Timer.island";
      export default () => (
        <div>
          <Counter />
          <Timer />
        </div>
      );
    `;

    const result = await transform(input, "/test/Page.tsx", "ssr");

    // Should have 2 solid-island tags
    const matches = result.match(/solid-island/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  test("should handle islands with complex props", async () => {
    const input = `
      import Counter from "./Counter.island";
      const data = { nested: true };
      export default () => <Counter items={[1,2,3]} user={{ name: "Alice" }} data={data} />;
    `;

    const result = await transform(input, "/test/Page.tsx", "ssr");

    expect(result).toContain("solid-island");
    expect(result).toContain("JSON.stringify(__seroval_toJSON(");
  });

  test("should handle islands without props", async () => {
    const input = `
      import Counter from "./Counter.island";
      export default () => <Counter />;
    `;

    const result = await transform(input, "/test/Page.tsx", "ssr");

    expect(result).toContain("solid-island");
    expect(result).toContain("<!--ssr-props:");
  });

  test("should preserve island children in SSR mode", async () => {
    const input = `
      import Box from "./Box.island";
      export default () => <Box><span>Child</span></Box>;
    `;

    const result = await transform(input, "/test/Page.tsx", "ssr");

    // In SSR mode, island should wrap the component (children preserved)
    expect(result).toContain("solid-island");
  });
});

describe("transform() - Client mode behavior", () => {
  test("should NOT inject seroval in DOM mode", async () => {
    const input = `
      import Counter from "./Counter.island";
      export default () => <Counter count={5} />;
    `;

    const result = await transform(input, "/test/Component.tsx", "dom");

    expect(result).not.toContain('from "seroval"');
    expect(result).not.toContain("__seroval_toJSON");
  });

  test("should NOT wrap components in DOM mode", async () => {
    const input = `
      import Counter from "./Counter.island";
      export default () => <Counter count={5} />;
    `;

    const result = await transform(input, "/test/Component.tsx", "dom");

    expect(result).not.toContain("solid-island");
    expect(result).not.toContain("solid-client");
    expect(result).not.toContain("data-id");
  });

  test("should still compile JSX in DOM mode", async () => {
    const input = `
      export default () => <div>Hello</div>;
    `;

    const result = await transform(input, "/test/Component.tsx", "dom");

    // Should contain some Solid runtime code (not SSR-specific)
    expect(result).not.toContain("ssr");
    expect(result.length).toBeGreaterThan(input.length); // Was transformed
  });
});

describe("transform() - Edge cases", () => {
  test("should handle default imports from islands", async () => {
    const input = `
      import MyIsland from "./components/MyIsland.island";
      export default () => <MyIsland />;
    `;

    const result = await transform(input, "/test/Page.tsx", "ssr");

    expect(result).toContain("solid-island");
  });

  test("should handle relative paths with ../", async () => {
    const input = `
      import Counter from "../shared/Counter.island";
      export default () => <Counter />;
    `;

    const result = await transform(input, "/test/Page.tsx", "ssr");

    expect(result).toContain("solid-island");
  });

  test("should resolve alias imports to file-based IDs", async () => {
    const root = makeTempRoot();
    const pagePath = join(root, "src", "pages", "Page.tsx");
    const islandPath = join(root, "src", "components", "Counter.island.tsx");

    mkdirSync(join(root, "src", "components"), { recursive: true });
    mkdirSync(join(root, "src", "pages"), { recursive: true });
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/*": ["src/*"],
          },
        },
      }),
    );
    writeFileSync(islandPath, "export default function Counter(){ return <button>ok</button>; }");

    const input = `
      import Counter from "@/components/Counter.island";
      export default () => <Counter />;
    `;

    const result = await transform(input, pagePath, "ssr", false, root);
    const expectedId = islandIdFromFile(islandPath, root);
    const generatedId = result.match(/data-id=\\\"([a-f0-9]{12})\\\"/)?.[1];

    expect(generatedId).toBe(expectedId);
  });

  test("should hard-fail for unresolved alias imports", async () => {
    const root = makeTempRoot();
    const pagePath = join(root, "src", "pages", "Page.tsx");

    mkdirSync(join(root, "src", "pages"), { recursive: true });
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/*": ["src/*"],
          },
        },
      }),
    );

    const input = `
      import Missing from "@/components/Missing.island";
      export default () => <Missing />;
    `;

    await expect(transform(input, pagePath, "ssr", false, root)).rejects.toThrow(/Failed to resolve island\/client import/);
  });

  test("should handle .tsx extension in import", async () => {
    const input = `
      import Counter from "./Counter.island.tsx";
      export default () => <Counter />;
    `;

    const result = await transform(input, "/test/Page.tsx", "ssr");

    expect(result).toContain("solid-island");
  });

  test("should handle TypeScript types in components", async () => {
    const input = `
      import Counter from "./Counter.island";
      type Props = { count: number };
      export default () => {
        const props: Props = { count: 5 };
        return <Counter {...props} />;
      };
    `;

    const result = await transform(input, "/test/Page.tsx", "ssr");

    expect(result).toContain("solid-island");
    expect(result).toContain('import Counter from "./Counter.island"');
    expect(result).not.toContain("type Props");
    expect(result).not.toContain(": Props");
  });

  test("should not wrap islands imported but not used", async () => {
    const input = `
      import Counter from "./Counter.island";
      export default () => <div>No counter here</div>;
    `;

    const result = await transform(input, "/test/Page.tsx", "ssr");

    // Should not contain solid-island since Counter is not rendered
    expect(result).not.toContain("solid-island");
  });
});

test("SSR alias does not collide with application toJSON or serialize imports", async () => {
  const result = await transform(
    `
    import { toJSON, serialize } from "seroval";
    import Probe from "./Probe.island";
    export const own = [toJSON({}), serialize({})];
    export default () => <Probe />;
  `,
    "/test/Page.tsx",
    "ssr",
  );
  expect(result).toContain('import { toJSON as __seroval_toJSON } from "seroval"');
  expect(result).toContain('import { toJSON, serialize } from "seroval"');
  expect(result).toContain("JSON.stringify(__seroval_toJSON(");
});

test("a transformed server page renders rich props as escaped JSON data", async () => {
  const root = makeResolvableTempRoot(".ssr-transform-props-");
  tempRoots.push(root);
  writeFileSync(join(root, "Probe.island.tsx"), "export default () => null;");
  const filename = join(root, "Page.tsx");
  const result = await transform(
    `
    import Probe from "./Probe.island";
    export default () => <Probe at={new Date("2026-10-01T12:34:56Z")} map={new Map([["k", "v"]])} text={'</script>"&'} />;
  `,
    filename,
    "ssr",
    false,
    root,
  );
  const output = join(root, "Page.js");
  writeFileSync(output, result);
  const { default: Page } = await import(output);
  const html = renderToString(() => Page());
  const decoded = await propsComment(html);
  const props = fromJSON<{ at: Date; map: Map<string, string>; text: string }>(JSON.parse(decoded!));
  expect(props.at.getTime()).toBe(new Date("2026-10-01T12:34:56Z").getTime());
  expect([...props.map]).toEqual([["k", "v"]]);
  expect(props.text).toBe('</script>"&');
});

test("spread attributes reach the island props in JSX order", async () => {
  const root = makeResolvableTempRoot(".ssr-transform-spread-");
  tempRoots.push(root);
  writeFileSync(join(root, "Probe.island.tsx"), "export default () => null;");
  const filename = join(root, "Page.tsx");
  const result = await transform(
    `
    import Probe from "./Probe.island";
    const props = { route: { view: "overview" }, label: "from spread", count: 1, get hidden() { throw new Error("read") } };
    export default () => <Probe label="before" {...props} count={2} hidden="override" {...{ label: undefined }} />;
  `,
    filename,
    "ssr",
    false,
    root,
  );
  const output = join(root, "Page.js");
  writeFileSync(output, result);
  const { default: Page } = await import(output);
  const html = renderToString(() => Page());
  const decoded = await propsComment(html);
  expect(fromJSON<Record<string, unknown>>(JSON.parse(decoded!))).toEqual({
    label: "from spread",
    route: { view: "overview" },
    count: 2,
    hidden: "override",
  });
});

test("island props travel as JSON data without attribute escaping", async () => {
  // A list island's typical props: many quoted keys and strings, a few characters an attribute would escape.
  const preamble = `const rows = Array.from({ length: 200 }, (_, i) => ({ id: "row-" + i, title: 'Say "hi" & <wave>', tags: ["a", "b"], done: i % 2 === 0 }));`;
  const html = await renderProbe("{ rows }", preamble);
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: `row-${i}`, title: 'Say "hi" & <wave>', tags: ["a", "b"], done: i % 2 === 0 }));
  const serialized = JSON.stringify(toJSON({ rows }));
  const { comments } = await parseHtml(html);
  expect(comments).toHaveLength(1);
  expect(fromJSON<{ rows: typeof rows }>(JSON.parse(comments[0]!.replace(/^ssr-props:/, "")))).toEqual({ rows });
  // Everything the wrapper adds besides the island's server markup, against seroval's own JSON form.
  const emitted = Buffer.byteLength(html.replace("<p>server</p>", ""));
  expect(emitted).toBeLessThanOrEqual(Buffer.byteLength(serialized) * 1.1);
  expect(html).not.toContain("&quot;");
});

test.each([
  ["a closing script tag and markup", "</script><img src=x onerror=globalThis.pwned=1>"],
  ["a comment end", "--><img src=x onerror=globalThis.pwned=1>"],
  ["the other comment end", "--!><img src=x>"],
  ["a nested comment", "<!--<!-- inner -->"],
  ["an unfinished comment opener at the end", "x <!-"],
  ["quotes and entities", `"' &amp; &lt; >`],
  ["line and paragraph separators", "line\u2028paragraph\u2029end"],
])("props with %s stay data inside their comment", async (_, text) => {
  const html = await renderProbe(`{ text: ${JSON.stringify(text)} }`);
  const { elements, comments } = await parseHtml(html);
  // The tokenizer sees exactly the page's elements and one comment: nothing in the props ended it or started markup.
  expect(elements).toEqual(["main", "solid-island", "p"]);
  expect(comments).toHaveLength(1);
  expect(comments[0]).toStartWith("ssr-props:");
  expect(comments[0]).not.toMatch(/[<>]/);
  expect(fromJSON<{ text: string }>(JSON.parse(comments[0]!.replace(/^ssr-props:/, "")))).toEqual({ text });
});
