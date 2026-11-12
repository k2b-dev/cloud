import type { CodePageBlock } from "./page-authoring-types";

/** Opaque, expiring, single-use file from this run. Only Core can redeem it; it contains no bytes or URL. */
declare const __codeFileRef: unique symbol;
export type FileRef = {
  readonly [__codeFileRef]: true;
  readonly id: string;
  readonly name?: string;
  readonly mediaType: string;
  readonly size: number;
};

/** A generated SDK method bound to its application and optional resource. Only accepted in AI tools arrays. */
declare const __codeAiTool: unique symbol;
export type CodeAiTool = { readonly [__codeAiTool]: true };

/** A target identity created by a generated factory, never an authorization grant. */
declare const __codeHandle: unique symbol;
export type CodeHandle<Type extends string, Id extends string = string> = {
  readonly [__codeHandle]: Type;
  readonly type: Type;
  readonly id: Id;
};
/** Query data and the capability envelope's optional pagination, shared by queries returning domain data. */
export type CodeQueryResult<Data> = {
  data: Data;
  page?: { hasMore: true; nextCursor: string } | { hasMore: false };
};
/** Visitor identity is presentation and handler input, never the authority for SDK data calls. */
export type CodeUser = {
  id: string;
  /** Cloud login handle, distinct from the immutable user ID. */
  username: string;
  groupIds: string[];
  groupNames: string[];
  /** The signed-in person's Cloud account profile. Workload accounts cannot visit private pages. */
  kind: "user" | "guest";
  name: string;
};
/** Request helpers for hosted routes. */
export type CodeRequest = {
  raw: Request;
  readonly path: string;
  readonly method: string;
  param(name: string): string;
  query(name: string): string | undefined;
  json(): Promise<unknown>;
  text(): Promise<string>;
  formData(): Promise<FormData>;
};
/** Authenticated route context. */
export type CodeContext<Variables extends object = {}> = {
  /** Request-local variables, declared once on app.use<Variables>(). */
  set<Key extends keyof Variables & string>(key: Key, value: Variables[Key]): void;
  get<Key extends keyof Variables & string>(key: Key): Variables[Key];
  req: CodeRequest;
  user: CodeUser | null;
  json(value: unknown, status?: number): Response;
  text(value: string, status?: number): Response;
  /** Draws a page built from SDK blocks; its root is `<Page>`. */
  page(page: CodePageBlock): Response;
  redirect(location: string, status?: number): Response;
};
/** Call once to run the next matching middleware or route handler. */
export type CodeNext = () => Promise<Response>;
/** Return a response to stop, or call next(); awaiting next() may also return void. */
export type CodeMiddleware<Variables extends object = {}> = (
  c: CodeContext<Variables>,
  next: CodeNext,
) => Response | void | Promise<Response | void>;
/** One schedule occurrence, stable across retries. Manual runs have scheduledAt null. */
export type CodeScheduleContext = { runId: string; scheduledAt: string | null; input: unknown };
export type CodeScheduleHandler = (context: CodeScheduleContext) => void | Promise<void>;
/** Known platform refusals. Applications may add their own stable codes. */
export type KnownCodeErrorCode =
  | "ai_disabled"
  | "ai_input_too_large"
  | "ai_invalid_output"
  | "ai_model_unavailable"
  | "ai_no_model"
  | "chat_busy"
  | "chat_changed"
  | "code_access_forbidden"
  | "code_access_removed"
  | "code_activation_draining"
  | "code_admission_refused"
  | "code_ai_budget_limit"
  | "code_ai_budget_reserved"
  | "code_ai_daily_budget_limit"
  | "code_ai_owner_daily_budget_limit"
  | "code_ai_run_required"
  | "code_ai_tool_invalid"
  | "code_ai_tool_not_checked"
  | "code_analysis_failed"
  | "code_answer_lost"
  | "code_approval_required"
  | "code_approval_revoked"
  | "code_bridge_unavailable"
  | "code_bundle_failed"
  | "code_bundle_limit"
  | "code_bundle_mismatch"
  | "code_call_limit"
  | "code_capability_undeclared"
  | "code_chat_call_limit"
  | "code_chat_invalid_value"
  | "code_check_cancelled"
  | "code_check_failed"
  | "code_check_memory_limit"
  | "code_check_output_limit"
  | "code_check_time_limit"
  | "code_checker_unavailable"
  | "code_code_false"
  | "code_cleanup_binding_invalid"
  | "code_cleanup_failed"
  | "code_cleanup_not_deleting"
  | "code_comparison_stale"
  | "code_csrf_required"
  | "code_db_busy"
  | "code_db_full"
  | "code_db_invalid"
  | "code_db_limit"
  | "code_db_owner_full"
  | "code_db_sql"
  | "code_db_temporary"
  | "code_db_timeout"
  | "code_db_unavailable"
  | "code_db_undeclared"
  | "code_detached_sdk_method"
  | "code_disabled"
  | "code_duplicate_on"
  | "code_duplicate_route"
  | "code_duplicate_schedule"
  | "code_dynamic_event"
  | "code_entrypoints_changed"
  | "code_event_backlog_full"
  | "code_event_input"
  | "code_event_owner"
  | "code_event_undeclared"
  | "code_file_invalid"
  | "code_file_mismatch"
  | "code_file_observation_failed"
  | "code_file_size_limit"
  | "code_file_size_mismatch"
  | "code_file_source_refused"
  | "code_file_spent"
  | "code_file_target_refused"
  | "code_file_unavailable"
  | "code_hash_mismatch"
  | "code_http_allow_literal"
  | "code_http_failed"
  | "code_http_forbidden"
  | "code_http_grant_limit"
  | "code_http_input_limit"
  | "code_http_invalid_call"
  | "code_http_origin_dynamic"
  | "code_http_origin_forbidden"
  | "code_http_origin_invalid"
  | "code_http_origin_undeclared"
  | "code_http_path_forbidden"
  | "code_http_redirect_limit"
  | "code_http_result_limit"
  | "code_http_secret_forbidden"
  | "code_http_secret_unavailable"
  | "code_http_timeout"
  | "code_import_elided"
  | "code_import_forbidden"
  | "code_input_limit"
  | "code_invalid_call"
  | "code_invalid_cron"
  | "code_invalid_response"
  | "code_invalid_token"
  | "code_job_busy"
  | "code_job_call_limit"
  | "code_job_cancelled"
  | "code_job_failed"
  | "code_job_not_found"
  | "code_job_output_limit"
  | "code_job_request_limit"
  | "code_job_time_limit"
  | "code_mandate_mismatch"
  | "code_manifest_invalid"
  | "code_members_only"
  | "code_middleware_next_called_twice"
  | "code_no_entrypoint"
  | "code_not_active"
  | "code_operation_not_found"
  | "code_owner_deleted"
  | "code_owner_read"
  | "code_owner_reports_pending"
  | "code_owner_source_invalid"
  | "code_page_blocks"
  | "code_page_chart"
  | "code_page_child"
  | "code_page_component"
  | "code_page_data_only"
  | "code_page_duplicate_field"
  | "code_page_limit"
  | "code_page_root"
  | "code_page_table_columns"
  | "code_page_text"
  | "code_page_unknown_field"
  | "code_policy_never"
  | "code_rate_limited"
  | "code_removed_api"
  | "code_request_busy"
  | "code_request_cancelled"
  | "code_request_content_type"
  | "code_request_encoding"
  | "code_request_failed"
  | "code_request_limit"
  | "code_request_method"
  | "code_request_rate_limit"
  | "code_request_size_limit"
  | "code_request_timeout"
  | "code_reserved_sdk"
  | "code_result_exceeds_capability_contract"
  | "code_result_not_storable"
  | "code_result_unknown"
  | "code_route_account_required"
  | "code_route_before_middleware"
  | "code_route_changed"
  | "code_route_not_found"
  | "code_route_unchecked"
  | "code_run_entrypoint"
  | "code_run_lease_unavailable"
  | "code_runner_metrics_unavailable"
  | "code_runner_required"
  | "code_runner_unavailable"
  | "code_schedule_delete_failed"
  | "code_schedule_sync_failed"
  | "code_scheduling_recovery_failed"
  | "code_sdk_bridge_unbound"
  | "code_sdk_duplicate_route"
  | "code_sdk_duplicate_schedule_name"
  | "code_sdk_idempotency_not_allowed"
  | "code_sdk_idempotency_required"
  | "code_sdk_invalid_bridge"
  | "code_sdk_invalid_handle"
  | "code_sdk_invalid_id"
  | "code_sdk_invalid_idempotency_key"
  | "code_sdk_invalid_input"
  | "code_sdk_invalid_middleware"
  | "code_sdk_invalid_route"
  | "code_sdk_invalid_schedule"
  | "code_sdk_invalid_schedule_name"
  | "code_sdk_invalid_schedule_title"
  | "code_sdk_invalid_secret_name"
  | "code_sdk_missing_entrypoint"
  | "code_sdk_readonly_secrets"
  | "code_sends_not_yet"
  | "code_sign_in_required"
  | "code_source_limit"
  | "code_source_path"
  | "code_static_event"
  | "code_static_middleware"
  | "code_static_route"
  | "code_static_schedule"
  | "code_static_title"
  | "code_stream_forbidden"
  | "code_test_ambiguous_mock"
  | "code_test_cancelled"
  | "code_test_case_limit"
  | "code_test_check_failed"
  | "code_test_checker_unavailable"
  | "code_test_fixture_path"
  | "code_test_invalid_call"
  | "code_test_invalid_fixture"
  | "code_test_invalid_idempotency"
  | "code_test_invalid_input"
  | "code_test_invalid_refs"
  | "code_test_missing_mock"
  | "code_test_mock_exhausted"
  | "code_test_output_limit"
  | "code_test_request_limit"
  | "code_test_runner_unavailable"
  | "code_type_suppression"
  | "code_typecheck_failed"
  | "code_unattended_forbidden"
  | "code_unavailable"
  | "code_unresolved_call"
  | "code_unresolved_ref"
  | "code_version_conflict"
  | "code_version_explanation"
  | "code_version_mismatch"
  | "code_version_stale"
  | "code_version_unavailable"
  | "code_wall_clock_limit"
  | "decision_images_not_supported"
  | "decision_input_invalid"
  | "decision_input_too_large"
  | "decision_model_unavailable"
  | "decision_not_configured"
  | "model_policy_mismatch"
  | "provider_aborted"
  | "provider_error"
  | "provider_stopped"
  | "quota_conflict"
  | "quota_exceeded"
  | "quota_exhausted"
  | "quota_usage_unknown"
  | "runner_lease_lost";
/** Keeps application-defined codes valid while offering the known codes in editors. */
export type CodeErrorCode = KnownCodeErrorCode | (string & {});
/** A refused SDK call. Codes are lowercase snake_case; status distinguishes forbidden and missing targets. */
export declare class CodeError extends Error {
  readonly code: CodeErrorCode;
  readonly status: number;
  readonly details: unknown;
  constructor(code: CodeErrorCode, status?: number, message?: string, details?: unknown);
}

/** Opaque header placeholder. It never contains a value; only Core can substitute it at an approved destination. */
declare const __codeSecret: unique symbol;
export type CodeSecret = string & { readonly [__codeSecret]: true };
/** Bounded public HTTPS result. Raw bytes are base64; text/json decode UTF-8 after Core redacts echoed credentials. */
export type CodeHttpResult = {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
};
export type CodeHttp = {
  /** Declare exact HTTPS origins for dynamic URLs and redirects. Literal array; never grants runtime authority. */
  allow(origins: readonly string[]): void;
  fetch(
    url: string,
    options?: {
      method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<CodeHttpResult>;
};

/** SQLite scalar parameters are sent as bound values, never interpolated into SQL. */
export type CodeDatabaseValue = string | number | boolean | null;
export type CodeDatabaseStatement = { sql: string; params?: readonly CodeDatabaseValue[] };
/** Persistent database owned by this Code, shared across its versions. */
export type CodeDatabase = {
  query<Row = Record<string, CodeDatabaseValue>>(sql: string, params?: readonly CodeDatabaseValue[]): Promise<Row[]>;
  exec(sql: string, params?: readonly CodeDatabaseValue[]): Promise<{ changes: number }>;
  batch(statements: readonly CodeDatabaseStatement[]): Promise<{ changes: number }[]>;
};

/** Decision questions accept boolean as an alias for the historical noul spelling. */
export type CodeDecisionQuestion =
  | { type: "noul" | "boolean"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
  | { type: "score"; instructions: unknown; criteria: readonly unknown[] };
/** input aliases state; when both are present state retains precedence. */
export type CodeDecisionInput<Input> = Omit<Input, "state" | "questions"> &
  ({ state: unknown; input?: unknown } | { input: unknown; state?: unknown }) & { questions: Record<string, CodeDecisionQuestion> };
export type CodeDecisionAnswer<Question, Answer> = Question extends { type: "boolean" | "noul" }
  ? Extract<Answer, { type: "noul" }> & { confidence: number }
  : Question extends { type: "choice"; criteria: infer Criteria }
    ? Omit<Extract<Answer, { type: "choice" }>, "choice"> & { choice: keyof Criteria & string }
    : Question extends { type: "score" }
      ? Extract<Answer, { type: "score" }>
      : Answer;
export type CodeDecisionData<Input, Data extends { answers: Record<string, unknown> }> = Omit<Data, "answers"> & {
  answers: Input extends { questions: infer Questions }
    ? {
        [Key in keyof Questions]: CodeDecisionAnswer<Questions[Key], Data["answers"][string]>;
      }
    : Data["answers"];
};
/** Broad required lists cannot prove which fields are present. */
type CodeJsonRequiredKeys<Schema> = Schema extends { required: readonly (infer Required)[] }
  ? string extends Required
    ? never
    : Required
  : never;
/** The supported JSON output schema projected into its validated result. */
export type CodeJsonOutput<Schema> = Schema extends { enum: readonly (infer Value)[] }
  ? Value
  : Schema extends { type: "string" }
    ? string
    : Schema extends { type: "number" | "integer" }
      ? number
      : Schema extends { type: "boolean" }
        ? boolean
        : Schema extends { type: "array"; items: infer Item }
          ? CodeJsonOutput<Item>[]
          : Schema extends { type: "object"; properties: infer Properties }
            ? {
                [Key in keyof Properties as Key extends CodeJsonRequiredKeys<Schema> ? Key : never]: CodeJsonOutput<Properties[Key]>;
              } & {
                [Key in keyof Properties as Key extends CodeJsonRequiredKeys<Schema> ? never : Key]?: CodeJsonOutput<Properties[Key]>;
              }
            : unknown;
export type CodeGenerationOutput<Input> = Input extends { output: infer Output }
  ? Output extends { type: "text" }
    ? string
    : Output extends { type: "json"; schema: infer Schema }
      ? CodeJsonOutput<Schema>
      : unknown
  : unknown;
