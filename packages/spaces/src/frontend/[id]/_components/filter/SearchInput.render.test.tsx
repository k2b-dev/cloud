import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "spaces-search-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: SearchInput } = await import("./SearchInput");

describe("Spaces SSR search fallback", () => {
  test("renders a GET form with the server term and filters, without the old query or page", () => {
    const html = renderToString(() =>
      createComponent(SearchInput, {
        value: "server term",
        baseUrl: "/app/spaces/Space1?view=list&status=all&q=server%20term&page=5",
      }),
    );
    expect(html).toContain('method="get"');
    expect(html).toContain('action="/app/spaces/Space1"');
    expect(html).toContain('name="q"');
    expect(html).toContain('value="server term"');
    expect(html).toContain('name="view" value="list"');
    expect(html).toContain('name="status" value="all"');
    expect(html).not.toContain('name="page"');
    expect(html.match(/name="q"/g)).toHaveLength(1);
  });
});
