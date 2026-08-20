import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import PrincipalInput from "./PrincipalInput";

const userId = "00000000-0000-4000-8000-000000000001";

describe("PrincipalInput", () => {
  test("renders multiple principals as the shared searchable multi-select field", () => {
    const html = renderToString(() =>
      createComponent(PrincipalInput, {
        name: "participants",
        label: "Participants",
        description: "People and groups who may work with this loan",
        required: true,
        value: [{ type: "user", id: userId }],
        multi: true,
        onChange: () => undefined,
      }),
    );

    expect(html).toContain("k2b-multi-select-trigger");
    expect(html).toContain("Participants");
    expect(html).toContain("People and groups who may work with this loan");
    expect(html).toContain("User");
    expect(html).toContain("user:");
    expect(html).toContain('aria-label="Filter principals"');
    expect(html).toContain(">All</button>");
    expect(html).toContain(">Users</button>");
    expect(html).toContain(">Groups</button>");
    expect(html).not.toContain("Type at least 2 characters");
  });

  test("renders a single principal with the shared select field", () => {
    const html = renderToString(() =>
      createComponent(PrincipalInput, {
        label: "Owner",
        value: null,
        multi: false,
        onChange: () => undefined,
      }),
    );

    expect(html).toContain("k2b-choice-trigger");
    expect(html).toContain("Select a user or group");
    expect(html).toContain(">Users</button>");
    expect(html).toContain(">Groups</button>");
    expect(html).not.toContain("k2b-multi-select-trigger");
  });

  test("can constrain the shared selector to groups", () => {
    const html = renderToString(() =>
      createComponent(PrincipalInput, {
        label: "Approver group",
        value: null,
        multi: false,
        types: ["group"],
        onChange: () => undefined,
      }),
    );

    expect(html).toContain("Approver group");
    expect(html).toContain("Select a group");
    expect(html).not.toContain("Select a user or group");
    expect(html).not.toContain('role="radiogroup"');
  });
});
