import { describe, expect, test } from "bun:test";
import { LocaleProvider } from "@k2b/ui";
import { renderToString } from "solid-js/web";
import AdminIssue from "../src/frontend/AdminIssue";
import { DirectoryStatus, IssueMessage } from "../src/frontend/feedback";

describe("Filesv2 server-rendered feedback", () => {
  test("all inventory states have readable localized labels independent of color", () => {
    const html = renderToString(() => (
      <LocaleProvider locale="de">
        <DirectoryStatus status="existing" />
        <DirectoryStatus status="missing" />
        <DirectoryStatus status="unassigned" />
        <DirectoryStatus status="conflict" />
        <DirectoryStatus status="unknown" />
        <DirectoryStatus status="orphaned" />
        <DirectoryStatus status="retired" />
      </LocaleProvider>
    ));
    for (const label of ["Vorhanden", "Fehlt", "Nicht zugeordnet", "Konflikt", "Unbekannt", "Verwaist", "Stillgelegt"])
      expect(html).toContain(label);
  });

  test("disabled, missing and inaccessible storage cannot render as an empty directory", () => {
    const html = renderToString(() => (
      <LocaleProvider locale="en">
        <IssueMessage code="local_linux_disabled" />
        <IssueMessage code="not_found" />
        <IssueMessage code="unavailable" />
      </LocaleProvider>
    ));
    expect(html).toContain("Cloud files require local Linux identities");
    expect(html).toContain("This directory is missing");
    expect(html).toContain("Storage is currently unavailable");
    expect(html).not.toContain("This folder is empty");
  });
  test("admin failures give actionable guidance without referring to another administrator", () => {
    const html = renderToString(() => (
      <LocaleProvider locale="en">
        <AdminIssue code="not_found" />
        <AdminIssue code="unavailable" />
        <AdminIssue code="identity_unknown" />
      </LocaleProvider>
    ));
    expect(html).toContain("This directory has not been created yet");
    expect(html).toContain("Check the connection");
    expect(html).not.toContain("Contact your administrator");
  });
});
