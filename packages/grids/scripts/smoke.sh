#!/usr/bin/env bash
# Grids API smoke tests against a running local dev stack.
#
# What this exercises:
#   - admin-login → session token
#   - the wire paths most likely to surface migration / live-parent
#     bugs (the "column ambiguous" we hit, the slug NOT-NULL+CHECK,
#     the parent-liveness JOINs)
#   - relation field create → record write → relation hydration on
#     read (Wave 1.3 transactional paths)
#   - field delete with deterministic saved-view diagnostics
#   - permission edge cases (Wave 2.1/2.2/2.3)
#
# Each step prints PASS / FAIL with a one-line context. Pass --debug
# to also dump response bodies.
#
# Usage:
#   bash packages/grids/scripts/smoke.sh [--base-url <url>] [--admin-token-file <path>] [--debug]

set -u  # unset-var = bug

BASE_URL="http://localhost:3000"
ADMIN_TOKEN="dev-admin"
DEBUG=0

usage() {
  cat <<'USAGE'
Usage: bash packages/grids/scripts/smoke.sh [options]

Grids API smoke tests against a running local dev stack.

Options:
  --base-url <url>            Cloud server (default http://localhost:3000)
  --admin-token-file <path>   File containing the dev admin token (default token "dev-admin")
  --debug                     Also dump response bodies
  --help                      Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url) BASE_URL="$2"; shift 2 ;;
    --admin-token-file) ADMIN_TOKEN="$(tr -d '\n' < "$2")"; shift 2 ;;
    --debug) DEBUG=1; shift ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colour the output a little so failures pop in long logs. NO_COLOR
# turns it off (e.g. for CI logs).
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_PASS=$'\033[32m'
  C_FAIL=$'\033[31m'
  C_DIM=$'\033[2m'
  C_RESET=$'\033[0m'
else
  C_PASS=""; C_FAIL=""; C_DIM=""; C_RESET=""
fi

PASS=0
FAIL=0
RESPONSE_BODY=""
RESPONSE_STATUS=""

# Run a curl request. Captures status + body separately so callers can
# assert on both. The body is read with -o so binary content (audit
# pages with real diffs) doesn't break terminal mode.
http() {
  local method="$1" path="$2" body="${3:-}" extra="${4:-}"
  local tmp
  tmp=$(mktemp)
  if [[ -n "$body" ]]; then
    RESPONSE_STATUS=$(
      curl -s -o "$tmp" -w "%{http_code}" \
        -X "$method" "$BASE_URL$path" \
        -H "Authorization: Bearer ${SESSION:-no-session}" \
        -H "Content-Type: application/json" \
        $extra \
        --data "$body"
    )
  else
    RESPONSE_STATUS=$(
      curl -s -o "$tmp" -w "%{http_code}" \
        -X "$method" "$BASE_URL$path" \
        -H "Authorization: Bearer ${SESSION:-no-session}" \
        $extra
    )
  fi
  RESPONSE_BODY=$(cat "$tmp")
  rm -f "$tmp"
  [[ "$DEBUG" == "1" ]] && echo "  ${C_DIM}$method $path → $RESPONSE_STATUS${C_RESET}" >&2 \
    && echo "  ${C_DIM}↳ ${RESPONSE_BODY:0:200}${C_RESET}" >&2
}

# pass <name> ; fail <name> <reason>
pass() { PASS=$((PASS+1)); echo "${C_PASS}✓${C_RESET} $1"; }
fail() {
  FAIL=$((FAIL+1))
  echo "${C_FAIL}✗${C_RESET} $1"
  echo "  ${C_FAIL}reason:${C_RESET} $2"
  echo "  ${C_FAIL}status:${C_RESET} $RESPONSE_STATUS"
  echo "  ${C_FAIL}body:${C_RESET} ${RESPONSE_BODY:0:400}"
}

# Assert the last response status matches an expected code. On
# mismatch records a FAIL with the body so the user sees what came
# back instead of "expected 200 got 500" alone.
expect_status() {
  local expected="$1" name="$2"
  if [[ "$RESPONSE_STATUS" == "$expected" ]]; then
    pass "$name"
  else
    fail "$name" "expected $expected, got $RESPONSE_STATUS"
  fi
}

# Pick a JSON value out of the last response body. jq required.
json() { echo "$RESPONSE_BODY" | jq -r "$1"; }

# Cleanup helper: tries to delete a resource but doesn't fail the
# test run if the delete itself errors (the resource may already be
# gone, e.g. when a previous step failed before creating it).
cleanup_delete() {
  local path="$1"
  http DELETE "$path"
  [[ "$DEBUG" == "1" ]] && echo "  ${C_DIM}cleanup: $path → $RESPONSE_STATUS${C_RESET}" >&2 || true
}

# ────────────────────────────────────────────────────────────────────
# Setup: admin login
# ────────────────────────────────────────────────────────────────────

echo ""
echo "━━━ admin-login ━━━"
http POST /api/auth/admin-login "{\"token\":\"$ADMIN_TOKEN\"}"
if [[ "$RESPONSE_STATUS" != "200" ]]; then
  echo "${C_FAIL}admin-login failed; bailing.${C_RESET}"
  echo "status: $RESPONSE_STATUS"
  echo "body:   $RESPONSE_BODY"
  exit 1
fi
SESSION=$(json '.session_token')
[[ -z "$SESSION" || "$SESSION" == "null" ]] && { echo "no session_token"; exit 1; }
pass "admin-login → session"

# ────────────────────────────────────────────────────────────────────
# Setup: create a fresh base + table + fields for the run.
# Each run picks a unique suffix so reruns don't collide.
# ────────────────────────────────────────────────────────────────────

SUFFIX="$(date +%s)$RANDOM"
echo ""
echo "━━━ setup ━━━"

http POST /api/grids/bases "{\"name\":\"smoke-base-$SUFFIX\"}"
expect_status 201 "POST /api/grids/bases → 201"
BASE_ID=$(json '.id')
[[ -z "$BASE_ID" || "$BASE_ID" == "null" ]] && { echo "no base id"; exit 1; }

http POST /api/grids/tables/by-base/$BASE_ID "{\"name\":\"items\"}"
expect_status 201 "POST /api/grids/tables/by-base/:base → 201"
ITEMS_TABLE_ID=$(json '.id')

http POST /api/grids/tables/by-base/$BASE_ID "{\"name\":\"orders\"}"
expect_status 201 "POST /api/grids/tables/by-base/:base (second table) → 201"
ORDERS_TABLE_ID=$(json '.id')

# Add scalar fields on items: text + number.
http POST /api/grids/fields/by-table/$ITEMS_TABLE_ID '{"name":"name","type":"text","required":true}'
expect_status 201 "POST fields/items.name (text) → 201"
NAME_FIELD_ID=$(json '.id')

http PATCH /api/grids/fields/$NAME_FIELD_ID '{"icon":"ti ti-tag"}'
expect_status 200 "PATCH fields/items.name icon → 200"
NAME_FIELD_ICON=$(json '.icon')
[[ "$NAME_FIELD_ICON" == "ti ti-tag" ]] && pass "field icon persists" \
  || fail "field icon" "expected ti ti-tag, got '$NAME_FIELD_ICON'"

http POST /api/grids/fields/by-table/$ITEMS_TABLE_ID '{"name":"description","type":"longtext"}'
expect_status 201 "POST fields/items.description (longtext) → 201"
DESC_FIELD_ID=$(json '.id')

http POST /api/grids/fields/by-table/$ITEMS_TABLE_ID '{"name":"price","type":"number","config":{"precision":16,"decimalPlaces":2,"unit":"EUR","unitPosition":"suffix"}}'
expect_status 201 "POST fields/items.price (number) → 201"
PRICE_FIELD_ID=$(json '.id')

http POST /api/grids/fields/by-table/$ITEMS_TABLE_ID '{"name":"attachment","type":"file"}'
expect_status 201 "POST fields/items.attachment (file) → 201"
FILE_FIELD_ID=$(json '.id')

http POST /api/grids/fields/by-table/$ITEMS_TABLE_ID '{"name":"tags","type":"select","config":{"multiple":true,"options":[{"id":"hardware","label":"Hardware"},{"id":"sale","label":"Sale"}]}}'
expect_status 201 "POST fields/items.tags (multi select) → 201"
TAGS_FIELD_ID=$(json '.id')

# Relation field on orders → items.
http POST /api/grids/fields/by-table/$ORDERS_TABLE_ID "{\"name\":\"item\",\"type\":\"relation\",\"config\":{\"targetTableId\":\"$ITEMS_TABLE_ID\",\"cardinality\":\"single\"}}"
expect_status 201 "POST fields/orders.item (relation) → 201"
RELATION_FIELD_ID=$(json '.id')

# Cross-table rollup on orders → SUM(items.price). Exercises
# buildComputedProjections.resolveTargetField — the price field lives
# on a DIFFERENT table than the rollup, so the projection has to
# fetch it via getField() instead of finding it in the source-table
# field list. Pre-final-review this silently dropped the projection
# and rollups across relations returned NULL.
http POST /api/grids/fields/by-table/$ORDERS_TABLE_ID "{\"name\":\"item_price_sum\",\"type\":\"rollup\",\"config\":{\"relationFieldId\":\"$RELATION_FIELD_ID\",\"targetFieldId\":\"$PRICE_FIELD_ID\",\"agg\":\"sum\"}}"
expect_status 201 "POST fields/orders.item_price_sum (cross-table rollup) → 201"
ROLLUP_FIELD_ID=$(json '.id')

# ────────────────────────────────────────────────────────────────────
# Public-ID invariant: every resource exposes one 6-character id.
# ────────────────────────────────────────────────────────────────────

echo ""
echo "━━━ public id invariant ━━━"

http GET /api/grids/bases/$BASE_ID
expect_status 200 "GET base"
[[ "$BASE_ID" =~ ^[A-Za-z0-9]{6}$ ]] && pass "base id matches /^[A-Za-z0-9]{6}\$/" \
  || fail "base public id shape" "got '$BASE_ID'"

http GET /api/grids/tables/$ITEMS_TABLE_ID
[[ "$ITEMS_TABLE_ID" =~ ^[A-Za-z0-9]{6}$ ]] && pass "table id matches /^[A-Za-z0-9]{6}\$/" \
  || fail "table public id shape" "got '$ITEMS_TABLE_ID'"

# ────────────────────────────────────────────────────────────────────
# Cross-base relation rejection (Wave 5.2 critical)
# ────────────────────────────────────────────────────────────────────

echo ""
echo "━━━ cross-base relation rejected ━━━"

http POST /api/grids/bases '{"name":"smoke-other-base"}'
OTHER_BASE_ID=$(json '.id')
http POST /api/grids/tables/by-base/$OTHER_BASE_ID '{"name":"strangers"}'
OTHER_TABLE_ID=$(json '.id')

http POST /api/grids/fields/by-table/$ITEMS_TABLE_ID "{\"name\":\"bad\",\"type\":\"relation\",\"config\":{\"targetTableId\":\"$OTHER_TABLE_ID\",\"cardinality\":\"single\"}}"
expect_status 400 "POST cross-base relation → 400"

# Cleanup the other base — keeps the dev DB tidy across reruns.
cleanup_delete /api/grids/bases/$OTHER_BASE_ID

# ────────────────────────────────────────────────────────────────────
# Number config invariant: decimalPlaces > precision rejected.
# ────────────────────────────────────────────────────────────────────

echo ""
echo "━━━ number config invariant ━━━"

http POST /api/grids/fields/by-table/$ITEMS_TABLE_ID '{"name":"badnum","type":"number","config":{"precision":5,"decimalPlaces":10}}'
expect_status 400 "POST number decimalPlaces>precision → 400"

BAD_FORM=$(cat <<JSON
{
  "name": "bad-form",
  "config": {
    "fields": [
      {"kind": "user_input", "fieldId": "$NAME_FIELD_ID"},
      {"kind": "user_input", "fieldId": "$NAME_FIELD_ID"}
    ]
  }
}
JSON
)
http POST /api/grids/forms/by-table/$ITEMS_TABLE_ID "$BAD_FORM"
expect_status 400 "POST form with duplicate field → 400"

# ────────────────────────────────────────────────────────────────────
# Record CRUD + transactional create + relation hydration (Wave 1.3)
# ────────────────────────────────────────────────────────────────────

echo ""
echo "━━━ records + relations ━━━"

http POST /api/grids/records/by-table/$ITEMS_TABLE_ID "{\"$NAME_FIELD_ID\":\"widget\",\"$DESC_FIELD_ID\":\"**bold** item\",\"$PRICE_FIELD_ID\":99.99,\"$TAGS_FIELD_ID\":[\"hardware\",\"sale\"]}"
expect_status 201 "POST item record → 201"
ITEM_REC_ID=$(json '.id')
PRICE_TYPE=$(json ".data[\"$PRICE_FIELD_ID\"] | type")
PRICE_VALUE=$(json ".data[\"$PRICE_FIELD_ID\"]")
if [[ "$PRICE_TYPE" == "string" && "$PRICE_VALUE" == "99.99" ]]; then
  pass "number field stores decimal-safe string"
else
  fail "number field canonical storage" "expected string 99.99, got type=$PRICE_TYPE value=$PRICE_VALUE"
fi

http GET "/api/grids/tables/$ITEMS_TABLE_ID/lookup?q=widget"
expect_status 200 "GET relation lookup baseline → 200"
LOOKUP_BASE_TYPE=$(json '.items | type')
LOOKUP_BASE_HAS_ITEM=$(json ".items | if type == \"array\" then any(.[]; .id == \"$ITEM_REC_ID\") else false end")
if [[ "$LOOKUP_BASE_TYPE" == "array" && "$LOOKUP_BASE_HAS_ITEM" == "true" ]]; then
  pass "relation lookup baseline finds selected record"
else
  fail "relation lookup baseline" "expected items[] to include $ITEM_REC_ID, got type=$LOOKUP_BASE_TYPE hasItem=$LOOKUP_BASE_HAS_ITEM"
fi

http GET "/api/grids/tables/$ITEMS_TABLE_ID/lookup?q=widget&excludeIds=$ITEM_REC_ID"
expect_status 200 "GET relation lookup with excludeIds → 200"
LOOKUP_EXCLUDED_TYPE=$(json '.items | type')
LOOKUP_EXCLUDED_HAS_ITEM=$(json ".items | if type == \"array\" then any(.[]; .id == \"$ITEM_REC_ID\") else true end")
if [[ "$LOOKUP_EXCLUDED_TYPE" == "array" && "$LOOKUP_EXCLUDED_HAS_ITEM" == "false" ]]; then
  pass "relation lookup excludeIds hides selected record"
else
  fail "relation lookup excludeIds" "expected items[] to omit $ITEM_REC_ID, got type=$LOOKUP_EXCLUDED_TYPE hasItem=$LOOKUP_EXCLUDED_HAS_ITEM"
fi

LOOKUP_UNUSED_ID="$BASE_ID"
http GET "/api/grids/tables/$ITEMS_TABLE_ID/lookup?q=widget&excludeIds=$ITEM_REC_ID,$LOOKUP_UNUSED_ID"
expect_status 200 "GET relation lookup with multiple excludeIds → 200"
LOOKUP_MULTI_HAS_ITEM=$(json ".items | if type == \"array\" then any(.[]; .id == \"$ITEM_REC_ID\") else true end")
if [[ "$LOOKUP_MULTI_HAS_ITEM" == "false" ]]; then
  pass "relation lookup multiple excludeIds hides selected record"
else
  fail "relation lookup multiple excludeIds" "expected items[] to omit $ITEM_REC_ID, got hasItem=$LOOKUP_MULTI_HAS_ITEM"
fi

http GET "/api/grids/tables/$ITEMS_TABLE_ID/lookup?q=widget&excludeIds=not-an-id"
expect_status 400 "GET relation lookup invalid excludeIds → 400"

http GET "/api/grids/tables/$ITEMS_TABLE_ID/lookup?q=widget&excludeIds=$ITEM_REC_ID,not-an-id"
expect_status 400 "GET relation lookup mixed invalid excludeIds → 400"

http POST /api/grids/records/by-table/$ORDERS_TABLE_ID "{\"$RELATION_FIELD_ID\":[\"$ITEM_REC_ID\"]}"
expect_status 201 "POST order with relation link → 201"
ORDER_REC_ID=$(json '.id')

# Read it back through the unified query endpoint — exercises records.list
# + record_links hydration + the live-parent JOINs.
http POST /api/grids/tables/$ORDERS_TABLE_ID/query '{"query":{}}'
expect_status 200 "POST tables/:id/query (orders) → 200"
HYDRATED=$(json ".items[] | select(.id==\"$ORDER_REC_ID\") | .data[\"$RELATION_FIELD_ID\"][0]")
[[ "$HYDRATED" == "$ITEM_REC_ID" ]] && pass "relation hydrated on list" \
  || fail "relation hydration" "expected '$ITEM_REC_ID', got '$HYDRATED'"

http POST /api/grids/tables/$ORDERS_TABLE_ID/query "{\"query\":{\"filter\":{\"fieldId\":\"$RELATION_FIELD_ID\",\"op\":\"containsAny\",\"value\":[\"$ITEM_REC_ID\"]}}}"
expect_status 200 "POST relation containsAny filter → 200"
REL_FILTER_MATCH=$(json ".items[] | select(.id==\"$ORDER_REC_ID\") | .id")
[[ "$REL_FILTER_MATCH" == "$ORDER_REC_ID" ]] && pass "relation containsAny returns linked record" \
  || fail "relation containsAny result" "expected '$ORDER_REC_ID', got '$REL_FILTER_MATCH'"

# Cross-table rollup: the rollup column on orders should expose the
# price of the linked item (99.99 — only one item linked from this
# order). Pre-fix this returned null because buildComputedProjections
# couldn't resolve the target field's storage descriptor across tables.
ROLLUP=$(json ".items[] | select(.id==\"$ORDER_REC_ID\") | .data[\"$ROLLUP_FIELD_ID\"]")
if [[ "$ROLLUP" == "99.99" || "$ROLLUP" == "99.990000" ]]; then
  pass "cross-table rollup projects target value"
else
  fail "cross-table rollup" "expected 99.99, got '$ROLLUP'"
fi

# File field: upload/list/download/delete. The bytes live in grids.files;
# the explicit file delete below verifies their normal lifecycle.
FILE_TMP=$(mktemp)
printf "hello grids smoke" > "$FILE_TMP"
UPLOAD_TMP=$(mktemp)
RESPONSE_STATUS=$(
  curl -s -o "$UPLOAD_TMP" -w "%{http_code}" \
    -X POST "$BASE_URL/api/grids/records/$ITEMS_TABLE_ID/$ITEM_REC_ID/files/$FILE_FIELD_ID" \
    -H "Authorization: Bearer ${SESSION:-no-session}" \
    -F "file=@$FILE_TMP;type=text/plain"
)
RESPONSE_BODY=$(cat "$UPLOAD_TMP")
rm -f "$UPLOAD_TMP" "$FILE_TMP"
expect_status 200 "POST file upload → 200"
GRID_FILE_ID=$(json '.id')

http GET /api/grids/records/$ITEMS_TABLE_ID/$ITEM_REC_ID/files/$FILE_FIELD_ID
expect_status 200 "GET file list → 200"
FILE_COUNT=$(json '.items | length')
[[ "$FILE_COUNT" == "1" ]] && pass "file list returns uploaded file" \
  || fail "file list count" "expected 1, got $FILE_COUNT"

http GET /api/grids/records/$ITEMS_TABLE_ID/$ITEM_REC_ID/files/$FILE_FIELD_ID/$GRID_FILE_ID/content
expect_status 200 "GET file content → 200"
[[ "$RESPONSE_BODY" == "hello grids smoke" ]] && pass "file download returns stored bytes" \
  || fail "file download content" "got '$RESPONSE_BODY'"

http DELETE /api/grids/records/$ITEMS_TABLE_ID/$ITEM_REC_ID/files/$FILE_FIELD_ID/$GRID_FILE_ID
expect_status 204 "DELETE file → 204"

# ────────────────────────────────────────────────────────────────────
# Audit cross-table leak (Wave 2.4)
# ────────────────────────────────────────────────────────────────────

echo ""
echo "━━━ audit scoping ━━━"

# Legitimate audit lookup returns the create entry.
http GET /api/grids/records/$ITEMS_TABLE_ID/$ITEM_REC_ID/audit
expect_status 200 "GET audit (legit table+record) → 200"
AUDIT_COUNT=$(json '.items | length')
[[ "$AUDIT_COUNT" -ge 1 ]] && pass "audit returns ≥1 entry for legit pair" \
  || fail "audit legit count" "got $AUDIT_COUNT"

# Wrong-table guess — record exists, but in a different table. Must
# return empty (chunk 7 critical: was leaking).
http GET /api/grids/records/$ORDERS_TABLE_ID/$ITEM_REC_ID/audit
expect_status 200 "GET audit (wrong-table guess) → 200"
LEAKED=$(json '.items | length')
[[ "$LEAKED" == "0" ]] && pass "audit empty for wrong-table guess (no leak)" \
  || fail "audit cross-table leak" "got $LEAKED entries instead of 0"

# ────────────────────────────────────────────────────────────────────
# Group-by + aggregations: currency sum across records (group-compiler
# storage-descriptor adoption). Two items with prices that should sum
# via SUM(try_numeric(data->fld->>'amount')). Pre-refactor this was
# wired up inline; the descriptor now owns it and the smoke test pins
# the SQL contract.
# ────────────────────────────────────────────────────────────────────

echo ""
echo "━━━ group-by + aggregations ━━━"

# Add a second item so SUM has something non-trivial to aggregate.
http POST /api/grids/records/by-table/$ITEMS_TABLE_ID "{\"$NAME_FIELD_ID\":\"gadget\",\"$PRICE_FIELD_ID\":150,\"$TAGS_FIELD_ID\":[\"hardware\"]}"
expect_status 201 "POST second item record → 201"

http POST /api/grids/tables/$ITEMS_TABLE_ID/query "{\"query\":{\"filter\":{\"fieldId\":\"$TAGS_FIELD_ID\",\"op\":\"isAnyOf\",\"value\":[\"sale\"]},\"aggregations\":[{\"fieldId\":\"*\",\"agg\":\"count\"},{\"fieldId\":\"$PRICE_FIELD_ID\",\"agg\":\"sum\"}]}}"
expect_status 200 "POST list query returns requested aggregates → 200"
DEFAULT_COUNT=$(json '.aggregates["*__count"]')
DEFAULT_SALE_SUM=$(json ".aggregates[\"${PRICE_FIELD_ID}__sum\"]")
if [[ "$DEFAULT_COUNT" == "1" && ( "$DEFAULT_SALE_SUM" == "99.99" || "$DEFAULT_SALE_SUM" == "99.990000" || "$DEFAULT_SALE_SUM" == "99.99000000000000" ) ]]; then
  pass "requested list aggregates respect filter over full result set"
else
  fail "requested list aggregates" "expected count=1 sum=99.99, got count=$DEFAULT_COUNT sum=$DEFAULT_SALE_SUM"
fi

echo ""
echo "━━━ search + export ━━━"

http POST /api/grids/tables/$ITEMS_TABLE_ID/query "{\"query\":{\"search\":{\"q\":\"widget\"}}}"
expect_status 200 "POST search text → 200"
SEARCH_HITS=$(json '.items | length')
[[ "$SEARCH_HITS" -ge 1 ]] && pass "search finds text field" \
  || fail "search text hits" "expected ≥1, got $SEARCH_HITS"

http POST /api/grids/tables/$ITEMS_TABLE_ID/query "{\"query\":{\"filter\":{\"fieldId\":\"$TAGS_FIELD_ID\",\"op\":\"isAnyOf\",\"value\":[\"sale\"]},\"search\":{\"q\":\"gadget\",\"fieldIds\":[]}}}"
expect_status 200 "POST filter+search precedence → 200"
FILTER_SEARCH_HITS=$(json '.items | length')
[[ "$FILTER_SEARCH_HITS" == "0" ]] && pass "filter+search keeps AND precedence" \
  || fail "filter+search precedence" "expected 0 hits, got $FILTER_SEARCH_HITS"

http POST /api/grids/tables/$ITEMS_TABLE_ID/query "{\"query\":{\"search\":{\"q\":\"99.99\",\"fieldIds\":[\"$PRICE_FIELD_ID\"]}}}"
expect_status 200 "POST search number scoped → 200"
SEARCH_NUMBER=$(json '.items | length')
[[ "$SEARCH_NUMBER" -ge 1 ]] && pass "search finds number field" \
  || fail "search number hits" "expected ≥1, got $SEARCH_NUMBER"

http POST /api/grids/tables/$ORDERS_TABLE_ID/query "{\"query\":{\"search\":{\"q\":\"widget\"}}}"
expect_status 200 "POST search relation label → 200"
SEARCH_REL=$(json '.items | length')
[[ "$SEARCH_REL" -ge 1 ]] && pass "search finds relation target label" \
  || fail "search relation hits" "expected ≥1, got $SEARCH_REL"

EXPORT_CSV_BODY=$(cat <<JSON
{
  "format": "csv",
  "query": {"search": {"q": "widget"}},
  "csv": {"delimiter": ";"},
  "markdown": "html",
  "fields": [
    {"fieldId": "$NAME_FIELD_ID", "label": "Product"},
    {"fieldId": "$DESC_FIELD_ID", "label": "HTML Description"},
    {"fieldId": "$PRICE_FIELD_ID", "label": "Price"}
  ]
}
JSON
)
http POST /api/grids/records/by-table/$ITEMS_TABLE_ID/export "$EXPORT_CSV_BODY"
expect_status 200 "POST export csv configurable → 200"
[[ "$RESPONSE_BODY" == *"Product;HTML Description;Price"* ]] && pass "csv export uses aliases + delimiter" \
  || fail "csv export header" "missing alias header"
[[ "$RESPONSE_BODY" == *"<strong>bold</strong>"* ]] && pass "csv export can render markdown as HTML" \
  || fail "csv markdown html" "missing rendered bold HTML"

EXPORT_JSON_BODY=$(cat <<JSON
{
  "format": "json",
  "query": {},
  "fields": [
    {"fieldId": "$RELATION_FIELD_ID", "label": "Item", "relation": {"mode": "fields", "fieldIds": ["$NAME_FIELD_ID", "$PRICE_FIELD_ID"]}}
  ]
}
JSON
)
http POST /api/grids/records/by-table/$ORDERS_TABLE_ID/export "$EXPORT_JSON_BODY"
expect_status 200 "POST export json relation fields → 200"
REL_EXPORT_NAME=$(json ".records[0].Item[0][\"$NAME_FIELD_ID\"]")
[[ "$REL_EXPORT_NAME" == "widget" ]] && pass "json export expands selected relation fields" \
  || fail "json relation export" "expected widget, got '$REL_EXPORT_NAME'"

# Group-by on a scalar (name field) with sum(price) — the simplest path
# that hits both resolveGroupBy and buildAggExpr through the descriptor.
http POST /api/grids/tables/$ITEMS_TABLE_ID/query "{\"query\":{\"groupBy\":[{\"fieldId\":\"$NAME_FIELD_ID\"}],\"aggregations\":[{\"fieldId\":\"$PRICE_FIELD_ID\",\"agg\":\"sum\"}]}}"
expect_status 200 "POST grouped query (sum) → 200"
BUCKETS=$(json '.buckets | length')
[[ "$BUCKETS" -ge 2 ]] && pass "grouped query returns ≥2 buckets" \
  || fail "grouped query bucket count" "expected ≥2, got $BUCKETS"

http POST /api/grids/tables/$ITEMS_TABLE_ID/query "{\"query\":{\"groupBy\":[{\"fieldId\":\"$TAGS_FIELD_ID\"}],\"aggregations\":[{\"fieldId\":\"*\",\"agg\":\"count\"}],\"groupSort\":[{\"fieldId\":\"*\",\"agg\":\"count\",\"direction\":\"desc\"}]}}"
expect_status 200 "POST grouped multi-select query sorted by count → 200"
TOP_TAG=$(json '.buckets[0].keys[0]')
TOP_TAG_COUNT=$(json '.buckets[0].values["*__count"]')
EXPLODE=$(json '.explode')
if [[ "$TOP_TAG" == "hardware" && "$TOP_TAG_COUNT" == "2" && "$EXPLODE" == "true" ]]; then
  pass "multi-select groupSort returns top exploded bucket"
else
  fail "multi-select groupSort" "expected hardware count=2 explode=true, got tag=$TOP_TAG count=$TOP_TAG_COUNT explode=$EXPLODE"
fi

# Footer aggregate path (no groupBy) — exercises the same buildAggExpr
# logic via aggregate-compiler. Total over both records.
http POST /api/grids/tables/$ITEMS_TABLE_ID/query "{\"query\":{\"aggregations\":[{\"fieldId\":\"$PRICE_FIELD_ID\",\"agg\":\"sum\"}]}}"
expect_status 200 "POST footer aggregate (sum) → 200"
SUM=$(json ".aggregates[\"${PRICE_FIELD_ID}__sum\"]")
# The first item was 99.99, second 150 → 249.99. Accept either string
# or number form (bun-sql may return numeric as string for big values).
if [[ "$SUM" == "249.99" || "$SUM" == "249.990000" || "$SUM" == "249.99000000000000" ]]; then
  pass "footer sum produces 249.99"
else
  fail "footer sum value" "expected 249.99, got '$SUM'"
fi

# ────────────────────────────────────────────────────────────────────
# Saved-view behavior after deleting a referenced field
# ────────────────────────────────────────────────────────────────────

echo ""
echo "━━━ saved-view field lifecycle ━━━"

# Saved views keep their canonical GQL source as authored. If a referenced
# field is deleted later, execution must fail with an explicit diagnostic
# rather than silently changing the query's meaning.
VIEW_SOURCE=$(printf "from table {%s}\nwhere {%s} > 50\nsort {%s} desc\nsearch 'x' in {%s}, {%s}" \
  "$ITEMS_TABLE_ID" "$PRICE_FIELD_ID" "$PRICE_FIELD_ID" "$PRICE_FIELD_ID" "$NAME_FIELD_ID")
VIEW_QUERY=$(jq -n \
  --arg name "expensive" \
  --arg source "$VIEW_SOURCE" \
  '{name: $name, shared: true, source: $source}')
http POST /api/grids/views/by-table/$ITEMS_TABLE_ID "$VIEW_QUERY"
expect_status 201 "POST canonical GQL view with price refs → 201"
VIEW_ID=$(json '.id')

# Drop the rollup first — it references price as a BLOCKING dependent
# (the dependents scanner rightly refuses to auto-cleanup
# rollup/lookup/formula refs since they have computed-cell semantics).
# Without this, the price-delete below would 409 instead of testing
# the view-cleanup auto-strip path.
cleanup_delete /api/grids/fields/$ROLLUP_FIELD_ID

http DELETE /api/grids/fields/$PRICE_FIELD_ID
expect_status 204 "DELETE price field → 204"

# The stored source remains stable for auditability and repair.
http GET /api/grids/views/$VIEW_ID
expect_status 200 "GET view after price delete → 200"
STORED_SOURCE=$(json '.source')
if [[ "$STORED_SOURCE" == *"$PRICE_FIELD_ID"* && "$STORED_SOURCE" == *"$NAME_FIELD_ID"* ]]; then
  pass "view keeps its canonical GQL source after field delete"
else
  fail "saved-view source stability" "expected canonical field refs, got: $STORED_SOURCE"
fi

http POST /api/grids/gql/by-base/$BASE_ID/views/$VIEW_ID/execute '{}'
expect_status 200 "POST saved view after field delete → 200 diagnostic response"
VIEW_EXECUTION_OK=$(json '.ok')
VIEW_DIAGNOSTIC=$(json '[.diagnostics[]?.message] | join("; ")')
if [[ "$VIEW_EXECUTION_OK" == "false" && "$VIEW_DIAGNOSTIC" == *"$PRICE_FIELD_ID"* ]]; then
  pass "saved view reports the deleted field explicitly"
else
  fail "saved-view deleted-field diagnostic" "expected field-specific diagnostic, got: $RESPONSE_BODY"
fi

# ────────────────────────────────────────────────────────────────────
# Permission resolver: explicit deny shadows inherited grant (Wave 2.1)
# ────────────────────────────────────────────────────────────────────
# The dev admin bypasses ACLs (platform admin), so we can't see deny
# behaviour from this session — but we can at least exercise the gate
# code path by hitting a 404 path consistent with non-existent ids.

echo ""
echo "━━━ negative paths ━━━"

http GET /api/grids/views/00000000-0000-0000-0000-000000000000
expect_status 404 "GET view does not resolve UUID → 404"

http POST /api/grids/tables/$ITEMS_TABLE_ID/query '{"query":{"sort":[{"fieldId":"000000","direction":"asc"}]}}'
expect_status 400 "POST query with unknown sort field → 400"

BAD_GQL_SOURCE=$(printf "from table {%s}\nwhere (" "$ITEMS_TABLE_ID")
BAD_GQL_VIEW=$(jq -n --arg source "$BAD_GQL_SOURCE" '{name: "bad-gql", source: $source}')
http POST /api/grids/views/by-table/$ITEMS_TABLE_ID "$BAD_GQL_VIEW"
expect_status 400 "POST view with invalid GQL → 400"

BAD_SEARCH_SOURCE=$(printf "from table {%s}\nsearch 'x' in {%s}" "$ITEMS_TABLE_ID" "$FILE_FIELD_ID")
BAD_SEARCH_VIEW=$(jq -n --arg source "$BAD_SEARCH_SOURCE" '{name: "bad-search-scope", source: $source}')
http POST /api/grids/views/by-table/$ITEMS_TABLE_ID "$BAD_SEARCH_VIEW"
expect_status 400 "POST view with unsearchable search field → 400"

# Sort on a relation field — Wave 4.1 made this a clean 400 instead
# of silently sorting all-NULL. Skip if we hit timing — relation
# field id may not always populate; fail-soft.
if [[ -n "${RELATION_FIELD_ID:-}" ]]; then
  http POST /api/grids/tables/$ORDERS_TABLE_ID/query "{\"query\":{\"sort\":[{\"fieldId\":\"$RELATION_FIELD_ID\",\"direction\":\"asc\"}]}}"
  expect_status 400 "POST query sort on relation field → 400"
fi

# ────────────────────────────────────────────────────────────────────
# Path-based SSR routes — verify Hono dispatches live Grids routes.
# The old settings route was intentionally removed; settings now open
# as a prompt from the workspace sidebar.
# ────────────────────────────────────────────────────────────────────

echo ""
echo "━━━ path-based SSR routes ━━━"

http GET /app/grids/$BASE_ID
expect_status 200 "GET /app/grids/<base>"

http GET /app/grids/$BASE_ID/table/$ITEMS_TABLE_ID
expect_status 200 "GET /app/grids/<base>/table/<table>"

http GET /app/grids/$BASE_ID/table/$ITEMS_TABLE_ID/edit
expect_status 302 "GET /app/grids/<base>/table/<table>/edit redirects to edit mode"

http GET /app/grids/$BASE_ID/table/$ITEMS_TABLE_ID/view/$VIEW_ID?edit=true
expect_status 200 "GET /app/grids/<base>/table/<table>/view/<view>?edit=true"

http GET /app/grids/$BASE_ID/settings
expect_status 404 "GET /app/grids/<base>/settings stays removed"

# ────────────────────────────────────────────────────────────────────
# Cleanup
# ────────────────────────────────────────────────────────────────────

echo ""
echo "━━━ cleanup ━━━"
cleanup_delete /api/grids/bases/$BASE_ID

# ────────────────────────────────────────────────────────────────────
# Summary
# ────────────────────────────────────────────────────────────────────

echo ""
echo "━━━ summary ━━━"
echo "${C_PASS}PASS:${C_RESET} $PASS    ${C_FAIL}FAIL:${C_RESET} $FAIL"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
