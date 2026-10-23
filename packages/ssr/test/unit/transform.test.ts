import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fromJSON } from "seroval";
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

describe("transform() - Island wrapping in SSR mode", () => {
  test("should wrap .island imports with solid-island tag", async () => {
    const input = `
      import Counter from "./Counter.island";
      export default () => <Counter count={5} />;
    `;

    const result = await transform(input, "/test/Page.tsx", "ssr");

    expect(result).toContain("solid-island");
    expect(result).toContain("data-id");
    expect(result).toContain("data-props");
  });

  test("should wrap .client imports with solid-client tag", async () => {
    const input = `
      import Widget from "./Widget.client";
      export default () => <Widget />;
    `;

    const result = await transform(input, "/test/Page.tsx", "ssr");

    expect(result).toContain("solid-client");
    expect(result).toContain("data-id");
    expect(result).toContain("data-props");
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

  test("should use __seroval_toJSON for data-props", async () => {
    const input = `
      import Counter from "./Counter.island";
      export default () => <Counter count={5} name="test" />;
    `;

    const result = await transform(input, "/test/Page.tsx", "ssr");

    expect(result).toContain("JSON.stringify(__seroval_toJSON(");
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
    expect(result).toContain("data-props");
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
  const attribute = html.match(/data-props="([^"]*)"/)?.[1];
  expect(attribute).toBeDefined();
  const decoded = attribute!.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  const props = fromJSON<{ at: Date; map: Map<string, string>; text: string }>(JSON.parse(decoded));
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
  const attribute = html.match(/data-props="([^"]*)"/)?.[1];
  expect(attribute).toBeDefined();
  const decoded = attribute!.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  expect(fromJSON<Record<string, unknown>>(JSON.parse(decoded))).toEqual({
    label: "from spread",
    route: { view: "overview" },
    count: 2,
    hidden: "override",
  });
});
