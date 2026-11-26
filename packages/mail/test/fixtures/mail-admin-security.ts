import type { MailAdminSecurityProps, SecurityView } from "../../src/frontend/_components/v2/MailAdminSecurity.island";
import type { MailProtectedIdentity, MailSecurityPolicy, MailSecurityReport } from "../../src/security-contracts";
import { keptAdminNav } from "./mail-admin-kept";

// Invented reports, rules and protected names for Cloud administration › Mail › Security; the page's wording is
// already applied (German), as the server hands it to the island.

const at = "2026-11-26T08:10:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const report = (
  n: number,
  sender: string | null,
  status: MailSecurityReport["status"],
  count: number,
  findings: [code: string, title: string][],
): MailSecurityReport => ({
  id: uuid(n),
  mailboxId: uuid(900 + n),
  messageId: uuid(500 + n),
  senderAddress: sender,
  senderDomain: sender?.split("@")[1] ?? null,
  status,
  reportCount: count,
  assessment: {
    risk: findings.length ? "warning" : "none",
    verdict: findings.length ? "suspicious" : "clear",
    findings: findings.map(([code, title]) => ({ code, title, explanation: title })),
    linksDisabled: false,
    evaluatedAt: at,
  },
  resolutionNote: status === "in_review" ? "Rückfrage bei der Buchhaltung läuft" : null,
  createdAt: at,
  updatedAt: at,
});

export const securityReports: MailSecurityReport[] = [
  report(1, "rechnung@paypal-konto-sicherheit.example.org", "new", 7, [
    ["authentication_failed", "Absender nicht bestätigt"],
    ["misleading_link", "Irreführender Link"],
  ]),
  report(2, "ceo@werkstatt-mail.example.org", "in_review", 3, [["protected_identity_mismatch", "Name einer geschützten Person"]]),
  report(3, "lieferung@dhl-zustellung.example.org", "new", 2, [["reply_to_mismatch", "Antwort geht woanders hin"]]),
  report(4, "info@newsletter.example.org", "dismissed", 1, []),
  report(5, null, "confirmed", 4, [["admin_deny_policy", "Gesperrter Absender"]]),
];

const policy = (
  n: number,
  disposition: MailSecurityPolicy["disposition"],
  target: MailSecurityPolicy["target"],
  value: string,
  note: string | null,
  enabled = true,
): MailSecurityPolicy => ({
  id: uuid(100 + n),
  disposition,
  target,
  value,
  note,
  enabled,
  createdAt: at,
  updatedAt: at,
});

export const securityPolicies: MailSecurityPolicy[] = [
  policy(1, "deny", "sender_domain", "paypal-konto-sicherheit.example.org", "Phishing-Welle November"),
  policy(2, "deny", "link_domain", "login-microsoft-verify.example.org", null),
  policy(3, "trust", "sender_domain", "steuerberatung-kern.example.org", "Kanzlei, signiert"),
  policy(4, "deny", "sender_address", "ceo@werkstatt-mail.example.org", "Meldung aus der Buchhaltung", false),
];

export const securityIdentities: MailProtectedIdentity[] = [
  {
    id: uuid(201),
    name: "Jana Berger",
    allowedDomains: ["werkstatt.example.org"],
    note: "Geschäftsführung",
    enabled: true,
    createdAt: at,
    updatedAt: at,
  },
  {
    id: uuid(202),
    name: "Buchhaltung",
    allowedDomains: ["werkstatt.example.org", "lohn.example.org"],
    note: null,
    enabled: true,
    createdAt: at,
    updatedAt: at,
  },
];

const states = {
  new: { label: "Neu", status: "warn" },
  in_review: { label: "In Prüfung", status: "warn" },
  confirmed: { label: "Bestätigt", status: "bad" },
  dismissed: { label: "Verworfen" },
} as const;

export const securityProps = (view: SecurityView = "reports", overrides: Partial<MailAdminSecurityProps> = {}): MailAdminSecurityProps => ({
  nav: keptAdminNav("de", "security"),
  view,
  searches: { reports: "", rules: "", identities: "" },
  figures: { open: 3, blocking: 2, trusted: 1, identities: 2 },
  reports: {
    rows: securityReports.map((item) => ({
      report: item,
      state: states[item.status],
      findings: item.assessment.findings.map((finding) => finding.title).join(" · ") || "Von Personen gemeldet",
      updated: { text: "vor 1 Std.", title: "26.11.2026, 09:10", iso: item.updatedAt },
    })),
    total: securityReports.length,
  },
  rules: {
    rows: securityPolicies.map((item) => ({
      policy: item,
      rule: item.disposition === "deny" ? "Sperren" : "Vertrauen",
      target: item.target === "sender_address" ? "Absenderadresse" : item.target === "sender_domain" ? "Absenderdomain" : "Linkdomain",
    })),
    total: securityPolicies.length,
  },
  identities: { rows: securityIdentities, total: securityIdentities.length },
  trustedAuthservIds: ["mx.werkstatt.example.org"],
  reportsPerDay: Array.from({ length: 30 }, (_, index) => [0, 0, 1, 0, 2, 0, 0, 1, 4, 0][index % 10] ?? 0),
  ...overrides,
});
