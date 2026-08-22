/**
 * Platform-owned settings, declared in the `defineApp({ settings: ... })` shape.
 *
 * These live in the framework, not in the core app, because every container
 * needs them registered: `settings.get("app.url")` and the per-request snapshot
 * resolve through `SETTINGS_MAP`, which is per-process. `defaults.ts` derives
 * its legacy entries from this object, and the core app passes it straight to
 * `defineApp({ settings })` so `app.settings.get/set` and `c.get("settings")`
 * keep their literal-type inference.
 *
 * Conventions:
 *   - omit `key` (it's the object key)
 *   - omit `group` (derived from the key prefix in the admin UI)
 *   - keep `description`, `label`, `placeholder`, `default`, `kind` complete
 */

const envString = (key: string): string | undefined => {
  const value = process.env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
};

const envCsv = (key: string): string | undefined => {
  const value = process.env[key]
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(",");
  return value && value.length > 0 ? value : undefined;
};

const hasRequiredFreeIpaEnv = (): boolean =>
  Boolean(envString("FREEIPA_URL") && envString("FREEIPA_SVC_USER") && envString("FREEIPA_SVC_PASSWORD"));

const IPA_MATCH_MODE_OPTIONS = [
  { value: "ignore", label: "Ignore local match" },
  { value: "migrate", label: "Migrate matching local account" },
] as const;

const IPA_ACCOUNT_TRANSITION_OPTIONS = [
  { value: "delete", label: "Delete account" },
  { value: "demote_to_local", label: "Make local (keep profile)" },
  { value: "demote_to_local_guest", label: "Make local guest" },
  { value: "demote_to_local_user", label: "Make local user" },
] as const;

export const CORE_SETTINGS = {
  // ── App ─────────────────────────────────────────────────────────────────
  "app.url": {
    kind: "string",
    label: "URL",
    default: "localhost:3000",
    description:
      "Public-facing application URL used for links in emails, OAuth redirects, and WebSocket connections (with or without scheme)",
    placeholder: "e.g. https://cloud.example.org",
    envFallback: () => envString("APP_URL"),
    envBootstrap: () => envString("APP_URL"),
  },
  "app.home_path": {
    kind: "string",
    label: "Home path",
    default: "/app/dashboard",
    description: "Local path opened after login and when visiting the Cloud root. It must be available to all signed-in users.",
    placeholder: "/app/dashboard",
  },
  "app.name": {
    kind: "string",
    label: "Name",
    default: "My App",
    description: "Application display name",
    placeholder: "e.g. MyCloud",
  },
  "app.contact_email": {
    kind: "email",
    label: "Contact Email",
    default: "",
    description: "Support contact email",
    placeholder: "e.g. support@example.org",
  },
  "app.copyright": {
    kind: "string",
    label: "Copyright",
    default: "",
    description: "Copyright holder name shown in footer",
    placeholder: "e.g. MyCompany",
  },
  "app.logo": {
    kind: "image",
    label: "Logo",
    default: "",
    description: "Logo image",
  },
  "app.favicon": {
    kind: "image",
    label: "Favicon",
    default: "",
    description: "Favicon",
  },
  "app.timezone": {
    kind: "timezone",
    label: "Timezone",
    default: "Europe/Berlin",
    description: "IANA timezone used for all scheduler-based jobs and time-based operations",
    placeholder: "e.g. Europe/Berlin",
  },
  "app.cleanup_schedule": {
    kind: "cron",
    label: "Cleanup Schedule",
    default: "0 4 * * *",
    description: "Five-field cron schedule used by all automatic cleanup jobs in app.timezone",
  },

  // ── AI ──────────────────────────────────────────────────────────────────
  "ai.enabled": {
    kind: "boolean",
    label: "Enable AI",
    default: false,
    description: "Enable Cloud AI features including personal conversations, Assistant, and app Capabilities.",
  },
  "ai.default_model_id": {
    kind: "string",
    label: "Default Model ID",
    default: "",
    description: "Model profile id used when an app asks for the platform default AI model.",
    placeholder: "e.g. openrouter-fast",
  },
  "ai.model_profiles_json": {
    kind: "text",
    label: "Model Profiles",
    default: "[]",
    description: "JSON array of model profiles. Provider API keys are stored on the profile they belong to.",
    placeholder:
      '[{"id":"openrouter-fast","label":"OpenRouter Fast","provider":"openrouter","model":"openai/gpt-4.1-mini","enabled":true,"dataBoundary":"hosted","capabilities":["streaming"],"apiKey":"sk-or-..."}]',
  },
  "ai.background_model_id": {
    kind: "string",
    label: "Background Model ID",
    default: "",
    description: "Model profile id used for background AI jobs. Empty = platform default model.",
    placeholder: "e.g. openrouter-fast",
  },
  "ai.vision_model_id": {
    kind: "string",
    label: "Vision Model ID",
    default: "",
    description: "Vision-capable model profile used by the view_image tool. Empty disables the tool fallback.",
    placeholder: "e.g. openrouter-vision",
  },
  "ai.workflow_model_id": {
    kind: "string",
    label: "Workflow Model ID",
    default: "",
    description: "Model profile id used for AI workflow actions. Empty = background model, then platform default.",
    placeholder: "e.g. openrouter-fast",
  },
  "ai.enrich_cron": {
    kind: "cron",
    label: "Chat Enrichment Schedule",
    default: "*/10 * * * *",
    description: "How often dirty chats get an AI-generated summary, keywords, and title refresh for search.",
  },
  "ai.memory_learning_cron": {
    kind: "cron",
    label: "Personalization Learning Schedule",
    default: "*/10 * * * *",
    description: "How often completed private-chat turns and repeated Cloud workflows are checked for durable personalization.",
  },
  "ai.memory_learning_monthly_token_budget": {
    kind: "number",
    label: "Personalization Monthly Token Budget",
    default: 100000,
    min: 10000,
    max: 10000000,
    description: "Maximum accounted background-personalization tokens per user and calendar month.",
  },
  "ai.chat_enrichment_instructions": {
    kind: "text",
    label: "Chat Enrichment Instructions",
    default: "",
    description: "Optional organization guidance added to the fixed chat enrichment task and output contract.",
    placeholder: "Prefer organization-specific terminology when it is present in the chat.",
  },
  "ai.memory_learning_instructions": {
    kind: "text",
    label: "Personalization Learning Instructions",
    default: "",
    description: "Optional organization guidance added to the fixed personalization learning task and privacy contract.",
    placeholder: "Keep learned preferences concise and use the user's language.",
  },
  "ai.global_instructions": {
    kind: "template",
    label: "Global Instructions",
    default: "",
    description:
      "Optional instructions applied to every Cloud AI conversation after platform guardrails. Supports Liquid: {{ user.displayName }}, {{ user.uid }}, {{ user.mail }}, {{ appId }}, {{ now }}, {{ today }}, {{ time }}.",
    placeholder: "Keep answers concise. The current user is {{ user.displayName }} and today is {{ today }}.",
    templateVars: ["user.displayName", "user.uid", "user.mail", "appId", "now", "today", "time"],
  },
  "ai.compaction_instructions": {
    kind: "text",
    label: "Compaction Instructions",
    default: "",
    description: "Optional organization guidance added to the fixed long-chat compaction task and completeness contract.",
    placeholder: "Preserve internal ticket ids and use the organization's canonical team names.",
  },
  "ai.max_tool_result_chars": {
    kind: "number",
    label: "Tool Result Ceiling",
    default: 2000000,
    min: 500,
    max: 4000000,
    description:
      "Operator ceiling for one tool result. The runtime uses a smaller budget automatically when the selected model has less context.",
  },
  "ai.firecrawl_api_key": {
    kind: "secret",
    label: "Firecrawl API Key",
    default: "",
    description: "Firecrawl API key used by Cloud AI web_search and web_extract tools.",
    placeholder: "fc-...",
  },
  // ── PDF rendering ─────────────────────────────────────────────────────
  "gotenberg.url": {
    kind: "url",
    label: "Gotenberg URL",
    default: "",
    description: "Internal base URL of the Gotenberg service used for HTML-to-PDF rendering.",
    placeholder: "e.g. http://gotenberg:3000",
  },
  "gotenberg.username": {
    kind: "string",
    label: "Basic Auth Username",
    default: "",
    description: "Optional Gotenberg Basic Auth username.",
    placeholder: "Gotenberg username",
  },
  "gotenberg.password": {
    kind: "secret",
    label: "Basic Auth Password",
    default: "",
    description: "Optional Gotenberg Basic Auth password.",
    placeholder: "Gotenberg password",
  },
  "gotenberg.timeout_ms": {
    kind: "number",
    label: "Timeout",
    default: 10000,
    min: 100,
    max: 120000,
    description: "Maximum time in milliseconds for one Gotenberg render request.",
  },
  "gotenberg.max_html_bytes": {
    kind: "number",
    label: "Max HTML Bytes",
    default: 1048576,
    min: 1024,
    max: 10485760,
    description: "Maximum HTML input size accepted before sending a render request.",
  },
  "gotenberg.max_pdf_bytes": {
    kind: "number",
    label: "Max PDF Bytes",
    default: 10485760,
    min: 1024,
    max: 104857600,
    description: "Maximum PDF output size accepted from Gotenberg.",
  },

  // ── FreeIPA ─────────────────────────────────────────────────────────────
  "freeipa.enable": {
    kind: "boolean",
    label: "Enable FreeIPA",
    default: false,
    description: "Enable FreeIPA-backed login, sync, account management, and IPA groups.",
    envFallback: () => hasRequiredFreeIpaEnv(),
    envBootstrap: () => (hasRequiredFreeIpaEnv() ? true : undefined),
  },
  "freeipa.url": {
    kind: "string",
    label: "Server Host",
    default: "freeipa.ipa.example.com",
    description: "FreeIPA host name used for RPC and login requests (without protocol).",
    placeholder: "e.g. ipa.example.org",
    envFallback: () => envString("FREEIPA_URL"),
    envBootstrap: () => envString("FREEIPA_URL"),
  },
  "freeipa.ca_cert": {
    kind: "text",
    label: "CA Certificate (PEM)",
    default: "",
    description:
      "Paste the FreeIPA root CA in PEM format to trust self-signed/private-CA servers without disabling validation. Preferred over allow_insecure.",
    placeholder: "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
  },
  "freeipa.allow_insecure": {
    kind: "boolean",
    label: "Allow Insecure TLS",
    default: false,
    description:
      "Skip TLS certificate validation entirely. Use only for local dev — disables MITM protection. Ignored when ca_cert is set.",
  },
  "freeipa.service_user": {
    kind: "string",
    label: "Service User",
    default: "svc-cloud",
    description: "FreeIPA service account username used for internal admin operations.",
    placeholder: "e.g. svc-cloud",
    envFallback: () => envString("FREEIPA_SVC_USER"),
    envBootstrap: () => envString("FREEIPA_SVC_USER"),
  },
  "freeipa.service_password": {
    kind: "secret",
    label: "Service Password",
    default: "",
    description: "FreeIPA service account password used for internal admin operations.",
    envFallback: () => envString("FREEIPA_SVC_PASSWORD"),
    envBootstrap: () => envString("FREEIPA_SVC_PASSWORD"),
  },
  "freeipa.groups.admin": {
    kind: "string_list",
    label: "Admin Groups",
    default: ["admins"] as readonly string[],
    description: "FreeIPA groups that imply app admin access.",
    placeholder: "admins,cloud-admins",
    envFallback: () => envCsv("GROUPS_ADMIN"),
    envBootstrap: () => envCsv("GROUPS_ADMIN"),
  },
  "freeipa.groups.base_sync": {
    kind: "string_list",
    label: "Base Sync Groups",
    default: [] as readonly string[],
    description:
      "Required. FreeIPA groups whose members get a Cloud account at all. There is no safe default — leaving this empty keeps FreeIPA incomplete rather than syncing your whole directory.",
    placeholder: "e.g. ipausers",
    envFallback: () => envCsv("GROUPS_BASE_SYNC"),
    envBootstrap: () => envCsv("GROUPS_BASE_SYNC"),
  },
  "freeipa.groups.base_ipa_realm": {
    kind: "string_list",
    label: "Base Realm Groups",
    default: [] as readonly string[],
    description:
      "Required. FreeIPA groups whose members become full users; everyone else in the sync scope becomes a guest. There is no safe default — leaving this empty keeps FreeIPA incomplete rather than demoting every account to guest.",
    placeholder: "e.g. staff",
    envFallback: () => envCsv("GROUPS_BASE_IPA_REALM"),
    envBootstrap: () => envCsv("GROUPS_BASE_IPA_REALM"),
  },
  "freeipa.groups.excluded": {
    kind: "string_list",
    label: "Excluded Groups",
    default: ["editors", "trust admins", "admins"] as readonly string[],
    description: "FreeIPA groups excluded from mirrored memberships and hierarchy logic.",
    placeholder: "editors,trust admins,admins",
    envFallback: () => envCsv("GROUPS_EXCLUDED"),
    envBootstrap: () => envCsv("GROUPS_EXCLUDED"),
  },
  "freeipa.user_match_mode": {
    kind: "enum",
    label: "User Match Mode",
    default: "ignore",
    description: "How IPA sync handles a unique local account match by email.",
    options: IPA_MATCH_MODE_OPTIONS,
  },
  "freeipa.account_transition_policy": {
    kind: "enum",
    label: "Account Transition Policy",
    default: "demote_to_local_guest",
    description: "What happens when an IPA-backed account expires or disappears from sync scope.",
    options: IPA_ACCOUNT_TRANSITION_OPTIONS,
  },
  "freeipa.sync_cron": {
    kind: "cron",
    label: "Sync Cron",
    default: "*/5 * * * *",
    description: "Five-field cron schedule for the FreeIPA sync job in app.timezone.",
  },
  "freeipa.sync_guard.max_user_changes": {
    kind: "number",
    label: "Max User Changes",
    default: 10,
    min: 0,
    description: "Maximum users one sync may remove from scope or demote. Zero blocks every destructive user change.",
  },
  "freeipa.sync_guard.max_user_change_percent": {
    kind: "number",
    label: "Max User Change Percent",
    default: 20,
    min: 0,
    max: 100,
    description: "Maximum percentage of existing IPA users one sync may remove from scope or demote.",
  },
  "freeipa.sync_guard.max_group_deletions": {
    kind: "number",
    label: "Max Group Deletions",
    default: 5,
    min: 0,
    description: "Maximum mirrored IPA groups one sync may delete. Zero blocks every group deletion.",
  },
  "freeipa.sync_guard.max_group_deletion_percent": {
    kind: "number",
    label: "Max Group Deletion Percent",
    default: 20,
    min: 0,
    max: 100,
    description: "Maximum percentage of existing IPA groups one sync may delete.",
  },

  // ── User ────────────────────────────────────────────────────────────────
  "user.allow_self_registration": {
    kind: "boolean",
    label: "Allow Self-Registration",
    default: false,
    description: "Allow creating a local guest account automatically during first email sign-in when no local account exists yet.",
  },
  "user.abbr_length": {
    kind: "number",
    label: "Username Abbreviation Length",
    default: 5,
    min: 1,
    description: "Length of randomly generated username abbreviations for new accounts",
  },
  "user.session.expiry_hours": {
    kind: "number",
    label: "Session Expiry Hours",
    default: 8,
    min: 1,
    description: "How long a login session stays valid (in hours)",
  },
  "user.account.ipa_expires_days": {
    kind: "number",
    label: "IPA Account Expiry Days",
    default: 365,
    min: 0,
    description: "IPA accounts expire after this many days (0 = never expires)",
  },
  "user.account.local_user_expires_days": {
    kind: "number",
    label: "Local User Expiry Days",
    default: 0,
    min: 0,
    description: "Local user accounts expire after this many days (0 = never expires)",
  },
  "user.account.local_guest_expires_days": {
    kind: "number",
    label: "Local Guest Expiry Days",
    default: 365,
    min: 0,
    description: "Local guest accounts expire after this many days (0 = never expires)",
  },
  "user.account.reminder_days": {
    kind: "number_list",
    label: "Reminder Days",
    default: [30, 7] as readonly number[],
    description: "Days before expiry to send reminder emails.",
  },
  "user.account.reminder_cron": {
    kind: "cron",
    label: "Reminder Cron",
    default: "0 9 * * *",
    description: "Five-field cron schedule for account expiry reminder runs in app.timezone",
  },
  "user.account.deleted_accounts_retention_days": {
    kind: "number",
    label: "Deleted Accounts Retention Days",
    default: 365,
    min: 0,
    description: "How many days deleted account history is kept before cleanup (0 = keep forever)",
  },
  "user.account.reminder_history_retention_days": {
    kind: "number",
    label: "Reminder History Retention Days",
    default: 365,
    min: 0,
    description: "How many days reminder history is kept before cleanup (0 = keep forever)",
  },

  // Internal Web Push identity. Generated once and encrypted with all other
  // settings; intentionally not exposed as an editable admin settings tab.
  "notifications.web_push_public_key": {
    kind: "string",
    label: "Web Push Public Key",
    default: "",
    description: "Generated VAPID public key for browser notification subscriptions.",
  },
  "notifications.web_push_private_key": {
    kind: "secret",
    label: "Web Push Private Key",
    default: "",
    description: "Generated VAPID private key for browser notification delivery.",
  },

  // ── Mail (templates + SMTP) ─────────────────────────────────────────────
  "mail.user_welcome_freeipa": {
    kind: "template",
    label: "FreeIPA Welcome Template",
    default: `<p>Your account has been created.</p>
<p><strong>Login credentials:</strong></p>
<p>Username: <code style="background:#f4f4f5;padding:2px 6px;border-radius:4px;">{{USERNAME}}</code></p>
<p>Temporary password: <code style="background:#f4f4f5;padding:2px 6px;border-radius:4px;">{{PASSWORD}}</code></p>
{% if EXPIRY != blank %}<p>Your account is valid until: <strong>{{EXPIRY}}</strong></p>{% endif %}
<p><a href="{{LOGIN_URL}}">Click here to login</a></p>
<p style="margin-top:24px;padding:12px;background:#f4f4f5;border-radius:6px;"><strong>Your username:</strong> <code style="font-size:16px;">{{USERNAME}}</code></p>
{% if CONTACT_EMAIL != blank %}<p>If you have any questions, please contact us at <a href="mailto:{{CONTACT_EMAIL}}">{{CONTACT_EMAIL}}</a>.</p>{% endif %}`,
    description: "FreeIPA welcome email template (HTML). Subject: Welcome to {{APP_NAME}}",
    templateVars: ["USERNAME", "PASSWORD", "EXPIRY", "LOGIN_URL", "CONTACT_EMAIL", "APP_NAME"] as readonly string[],
  },
  "mail.user_welcome_local": {
    kind: "template",
    label: "Local Welcome Template",
    default: `<p>Your account has been created.</p>
<p>Sign in with your email address: <code style="background:#f4f4f5;padding:2px 6px;border-radius:4px;">{{EMAIL}}</code></p>
{% if EXPIRY != blank %}<p>Your account is valid until: <strong>{{EXPIRY}}</strong></p>{% endif %}
<p><a href="{{LOGIN_URL}}">Open the login page</a> and choose email sign-in.</p>
{% if CONTACT_EMAIL != blank %}<p>If you have any questions, please contact us at <a href="mailto:{{CONTACT_EMAIL}}">{{CONTACT_EMAIL}}</a>.</p>{% endif %}`,
    description: "Local welcome email template (HTML). Subject: Welcome to {{APP_NAME}}",
    templateVars: ["EMAIL", "EXPIRY", "LOGIN_URL", "CONTACT_EMAIL", "APP_NAME"] as readonly string[],
  },
  "mail.magic_link_login": {
    kind: "template",
    label: "Magic Link Template",
    default: `<p style="text-align:center;margin:0 0 24px 0;">
  <code style="background:#f4f4f5;padding:8px 16px;border-radius:8px;letter-spacing:2px;font-weight:600;">{{TOKEN}}</code>
</p>
<p style="text-align:center;margin:0 0 24px 0;">
  <a href="{{MAGIC_LINK}}" target="_blank" style="color:#3b82f6;text-decoration:underline;">Click here to log in directly</a>
</p>
<p style="text-align:center;color:#71717a;font-size:12px;margin:0 0 8px 0;">This code expires in 5 minutes. Never share this code or link with anyone. If you didn't request this, please ignore this email.</p>`,
    description: "Magic link login email template (HTML). Subject: {{APP_NAME}} Login Code",
    templateVars: ["TOKEN", "MAGIC_LINK", "APP_NAME"] as readonly string[],
  },
  "mail.ipa_email_login_hint": {
    kind: "template",
    label: "FreeIPA Email Login Hint Template",
    default: `<p>A sign-in link was requested for <code style="background:#f4f4f5;padding:2px 6px;border-radius:4px;">{{EMAIL}}</code>.</p>
<p>This email address belongs to a FreeIPA-managed account. Please sign in with your FreeIPA username and password. If your email address is unique in FreeIPA, you can also use it instead of your username.</p>
<p style="text-align:center;margin:24px 0;">
  <a href="{{LOGIN_URL}}" target="_blank" style="color:#3b82f6;text-decoration:underline;">Open FreeIPA sign-in</a>
</p>
<p style="color:#71717a;font-size:12px;margin:0 0 8px 0;">No email login code was created. If you didn't request this, please ignore this email.</p>
{% if CONTACT_EMAIL != blank %}<p style="color:#71717a;font-size:12px;margin:0;">If you need help, contact <a href="mailto:{{CONTACT_EMAIL}}">{{CONTACT_EMAIL}}</a>.</p>{% endif %}`,
    description: "FreeIPA email-login hint template (HTML). Subject: {{APP_NAME}} FreeIPA Sign In",
    templateVars: ["EMAIL", "LOGIN_URL", "CONTACT_EMAIL", "APP_NAME"] as readonly string[],
  },
  "mail.password_reset": {
    kind: "template",
    label: "Password Reset Template",
    default: `<p>You requested a password reset for your {{APP_NAME}} account.</p>
<p style="text-align:center;margin:24px 0;">
  <a href="{{RESET_LINK}}" target="_blank" style="color:#3b82f6;text-decoration:underline;">Set a new password</a>
</p>
<p style="color:#71717a;font-size:12px;margin:0 0 8px 0;">This link expires in 15 minutes. Never share this link with anyone. If you didn't request this, you can ignore this email.</p>
{% if CONTACT_EMAIL != blank %}<p style="color:#71717a;font-size:12px;margin:0;">If you need help, contact <a href="mailto:{{CONTACT_EMAIL}}">{{CONTACT_EMAIL}}</a>.</p>{% endif %}`,
    description: "Password reset email template (HTML). Subject: {{APP_NAME}} Password Reset",
    templateVars: ["RESET_LINK", "APP_NAME", "CONTACT_EMAIL"] as readonly string[],
  },
  "mail.account_expiry_reminder": {
    kind: "template",
    label: "Account Expiry Reminder Template",
    default: `<p>Hi {{FIRST_NAME}},</p>
<p>Your {{APP_NAME}} account ({{ACCOUNT_KIND}}) will expire on <strong>{{EXPIRY}}</strong>.</p>
<p>You can extend your account here: <a href="{{EXTEND_URL}}">{{EXTEND_URL}}</a></p>
{% if CONTACT_EMAIL != blank %}<p>If you need help, contact <a href="mailto:{{CONTACT_EMAIL}}">{{CONTACT_EMAIL}}</a>.</p>{% endif %}`,
    description: "Account expiry reminder email template (HTML). Subject: {{APP_NAME}} Account Expiry",
    templateVars: ["FIRST_NAME", "DISPLAY_NAME", "EXPIRY", "EXTEND_URL", "APP_NAME", "CONTACT_EMAIL", "ACCOUNT_KIND"] as readonly string[],
  },
  "mail.account_request_denial": {
    kind: "template",
    label: "Account Request Denial Template",
    default: `<p>Hi {{FIRST_NAME}},</p>
<p>Your request for an account has been reviewed and unfortunately cannot be approved at this time.</p>
<p><strong>Reason:</strong> {{REASON}}</p>
{% if CONTACT_EMAIL != blank %}<p>If you have questions, please contact <a href="mailto:{{CONTACT_EMAIL}}">{{CONTACT_EMAIL}}</a>.</p>{% endif %}`,
    description: "Account request denial email template (HTML). Subject: Account Request Update",
    templateVars: ["FIRST_NAME", "REASON", "CONTACT_EMAIL", "APP_NAME"] as readonly string[],
  },
  "mail.noreply.smtp_host": {
    kind: "string",
    label: "SMTP Host",
    default: "",
    description: "SMTP server hostname",
    placeholder: "e.g. smtp.example.org",
  },
  "mail.noreply.smtp_port": {
    kind: "number",
    label: "SMTP Port",
    default: 587,
    min: 1,
    max: 65535,
    description: "SMTP server port (587 for STARTTLS, 465 for SSL)",
  },
  "mail.noreply.from": {
    kind: "email",
    label: "From Address",
    default: "",
    description: "From email address",
    placeholder: "e.g. noreply@example.org",
  },
  "mail.noreply.user": {
    kind: "string",
    label: "SMTP User",
    default: "",
    description: "SMTP username",
    placeholder: "e.g. noreply@example.org",
  },
  "mail.noreply.password": {
    kind: "secret",
    label: "SMTP Password",
    default: "",
    description: "SMTP password",
    placeholder: "SMTP password",
  },

  // ── Security ────────────────────────────────────────────────────────────
  "security.rate_limit_per_second": {
    kind: "number",
    label: "Requests Per Second",
    default: 60,
    min: 1,
    description: "Maximum API requests per second per IP address",
  },

  // ── Legal documents (Imprint, Privacy, Terms) ──────────────────────────
  // mode = "local"    → render markdown from `legal.<kind>.content`
  // mode = "external" → 302-redirect to `legal.<kind>.url`
  "legal.terms.mode": {
    kind: "enum",
    label: "Terms of Service Source",
    default: "local",
    options: [
      { value: "local", label: "Local content (markdown)" },
      { value: "external", label: "External URL (redirect)" },
    ],
    description: "How the Terms of Service page (/legal/terms) is served.",
  },
  "legal.terms.content": {
    kind: "text",
    label: "Terms of Service Content",
    default: "",
    description: "Markdown rendered at /legal/terms when source = local.",
    placeholder: "# Terms of Service\n\nYour terms here…",
  },
  "legal.terms.url": {
    kind: "url",
    label: "Terms of Service URL",
    default: "",
    description: "External URL redirected to from /legal/terms when source = external.",
    placeholder: "https://example.org/terms",
  },
  "legal.privacy.mode": {
    kind: "enum",
    label: "Privacy Policy Source",
    default: "local",
    options: [
      { value: "local", label: "Local content (markdown)" },
      { value: "external", label: "External URL (redirect)" },
    ],
    description: "How the Privacy Policy page (/legal/privacy) is served.",
  },
  "legal.privacy.content": {
    kind: "text",
    label: "Privacy Policy Content",
    default: "",
    description: "Markdown rendered at /legal/privacy when source = local.",
    placeholder: "# Privacy Policy\n\nYour privacy policy here…",
  },
  "legal.privacy.url": {
    kind: "url",
    label: "Privacy Policy URL",
    default: "",
    description: "External URL redirected to from /legal/privacy when source = external.",
    placeholder: "https://example.org/privacy",
  },
  "legal.imprint.mode": {
    kind: "enum",
    label: "Imprint Source",
    default: "local",
    options: [
      { value: "local", label: "Local content (markdown)" },
      { value: "external", label: "External URL (redirect)" },
    ],
    description: "How the Imprint page (/impressum) is served. Required by §5 TMG (German law).",
  },
  "legal.imprint.content": {
    kind: "text",
    label: "Imprint Content",
    default: "",
    description: "Markdown rendered at /impressum when source = local.",
    placeholder: "# Imprint\n\n**Operator**: Example Org\n\nAddress, contact, …",
  },
  "legal.imprint.url": {
    kind: "url",
    label: "Imprint URL",
    default: "",
    description: "External URL redirected to from /impressum when source = external.",
    placeholder: "https://example.org/imprint",
  },
} as const;
