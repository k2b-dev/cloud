import { check, sleep } from "k6";
import http from "k6/http";
import { Counter, Rate } from "k6/metrics";
import ws from "k6/ws";

const manifest = JSON.parse(open(__ENV.GRIDS_LOAD_MANIFEST || "/state/manifest.json"));
const baseUrl = (__ENV.GRIDS_LOAD_BASE_URL || "http://host.docker.internal:3000").replace(/\/$/, "");
const profile = __ENV.GRIDS_LOAD_PROFILE || "smoke";
const durationOverride = __ENV.GRIDS_LOAD_DURATION;
const scenarioFilter = new Set(
  (__ENV.GRIDS_LOAD_SCENARIOS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const includePdf = __ENV.GRIDS_LOAD_INCLUDE_PDF === "1" && Boolean(manifest.documentTemplateId);
const businessErrors = new Rate("business_errors");
const rateLimitedRequests = new Counter("rate_limited_requests");
const ingressRateLimitedRequests = new Counter("ingress_rate_limited_requests");
const queryOverloadedRequests = new Counter("query_overloaded_requests");
const readRate = Number(__ENV.GRIDS_LOAD_READ_RATE || 20);
const readMaxVus = Number(__ENV.GRIDS_LOAD_READ_MAX_VUS || 80);
const readOperation = __ENV.GRIDS_LOAD_READ_OPERATION || "mixed";
const readOperations = new Set(["mixed", "table", "gql-search", "gql-group"]);
if (!Number.isInteger(readRate) || readRate <= 0) throw new Error("GRIDS_LOAD_READ_RATE must be a positive integer");
if (!Number.isInteger(readMaxVus) || readMaxVus <= 0) throw new Error("GRIDS_LOAD_READ_MAX_VUS must be a positive integer");
if (!readOperations.has(readOperation)) throw new Error("GRIDS_LOAD_READ_OPERATION must be mixed, table, gql-search, or gql-group");

const profileOptions = {
  smoke: {
    read: { executor: "constant-vus", exec: "readFlow", vus: 2, duration: durationOverride || "20s" },
    write: { executor: "constant-vus", exec: "writeFlow", vus: 1, duration: durationOverride || "20s" },
    workflow: { executor: "constant-vus", exec: "workflowFlow", vus: 1, duration: durationOverride || "20s" },
    live: { executor: "constant-vus", exec: "liveFlow", vus: 1, duration: durationOverride || "20s" },
  },
  load: {
    read: {
      executor: "constant-arrival-rate",
      exec: "readFlow",
      rate: readRate,
      timeUnit: "1s",
      duration: durationOverride || "10m",
      preAllocatedVUs: Math.min(20, readMaxVus),
      maxVUs: readMaxVus,
    },
    write: {
      executor: "constant-arrival-rate",
      exec: "writeFlow",
      rate: 1,
      timeUnit: "1s",
      duration: durationOverride || "10m",
      preAllocatedVUs: 4,
      maxVUs: 12,
    },
    workflow: {
      executor: "constant-arrival-rate",
      exec: "workflowFlow",
      rate: 12,
      timeUnit: "1m",
      duration: durationOverride || "10m",
      preAllocatedVUs: 2,
      maxVUs: 8,
    },
    live: { executor: "constant-vus", exec: "liveFlow", vus: 5, duration: durationOverride || "10m" },
  },
  soak: {
    read: {
      executor: "constant-arrival-rate",
      exec: "readFlow",
      rate: readRate,
      timeUnit: "1s",
      duration: durationOverride || "2h",
      preAllocatedVUs: Math.min(20, readMaxVus),
      maxVUs: readMaxVus,
    },
    write: {
      executor: "constant-arrival-rate",
      exec: "writeFlow",
      rate: 1,
      timeUnit: "1s",
      duration: durationOverride || "2h",
      preAllocatedVUs: 4,
      maxVUs: 12,
    },
    workflow: {
      executor: "constant-arrival-rate",
      exec: "workflowFlow",
      rate: 12,
      timeUnit: "1m",
      duration: durationOverride || "2h",
      preAllocatedVUs: 2,
      maxVUs: 8,
    },
    live: { executor: "constant-vus", exec: "liveFlow", vus: 5, duration: durationOverride || "2h" },
  },
  stress: {
    read: {
      executor: "ramping-arrival-rate",
      exec: "readFlow",
      startRate: 10,
      timeUnit: "1s",
      preAllocatedVUs: 30,
      maxVUs: 250,
      stages: durationOverride
        ? [{ target: 100, duration: durationOverride }]
        : [
            { target: 25, duration: "2m" },
            { target: 50, duration: "3m" },
            { target: 100, duration: "3m" },
            { target: 0, duration: "1m" },
          ],
    },
    write: {
      executor: "constant-arrival-rate",
      exec: "writeFlow",
      rate: 3,
      timeUnit: "1s",
      duration: durationOverride || "9m",
      preAllocatedVUs: 8,
      maxVUs: 30,
    },
    workflow: {
      executor: "constant-arrival-rate",
      exec: "workflowFlow",
      rate: 30,
      timeUnit: "1m",
      duration: durationOverride || "9m",
      preAllocatedVUs: 4,
      maxVUs: 15,
    },
    live: { executor: "constant-vus", exec: "liveFlow", vus: 20, duration: durationOverride || "9m" },
  },
};

if (!profileOptions[profile]) throw new Error(`Unknown load profile: ${profile}`);
const scenarios = Object.fromEntries(
  Object.entries(profileOptions[profile]).filter(([name]) => scenarioFilter.size === 0 || scenarioFilter.has(name)),
);
if (includePdf) {
  scenarios.pdf = {
    executor: "constant-arrival-rate",
    exec: "pdfFlow",
    rate: 2,
    timeUnit: "1m",
    duration: durationOverride || (profile === "soak" ? "2h" : profile === "smoke" ? "20s" : profile === "stress" ? "9m" : "10m"),
    preAllocatedVUs: 1,
    maxVUs: 4,
  };
}
if (Object.keys(scenarios).length === 0) throw new Error("GRIDS_LOAD_SCENARIOS did not match a load-test scenario");

const operationThresholds = ["table-list", "table-page", "gql-search", "gql-group", "record-get", "record-update", "workflow-invoke"].map(
  (operation) => [`http_req_duration{operation:${operation}}`, ["p(95)<1500", "p(99)<3000"]],
);

export const options = {
  scenarios,
  discardResponseBodies: false,
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  thresholds: {
    business_errors: ["rate<0.01"],
    checks: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
    http_req_duration:
      profile === "stress"
        ? ["p(95)<3000", "p(99)<6000"]
        : profile === "load" || profile === "soak"
          ? ["p(95)<250", "p(99)<500"]
          : ["p(95)<1500", "p(99)<3000"],
    ...Object.fromEntries(operationThresholds),
  },
};

const headers = () => ({
  authorization: `Bearer ${manifest.apiToken}`,
  "content-type": "application/json",
  "x-forwarded-for": `198.18.${Math.floor(__VU / 250) % 250}.${(__VU % 250) + 1}`,
});

const jsonRequest = (method, path, body, tags, responseType) =>
  http.request(method, `${baseUrl}${path}`, body === undefined ? null : JSON.stringify(body), {
    headers: headers(),
    tags,
    responseType: responseType || "text",
    timeout: "30s",
  });

const responseOk = (response, label, validate) => {
  if (response.status === 429) {
    ingressRateLimitedRequests.add(1, { operation: label });
    rateLimitedRequests.add(1, { operation: label });
  } else if (response.status === 503) {
    queryOverloadedRequests.add(1, { operation: label });
    rateLimitedRequests.add(1, { operation: label });
  }
  const transportOk = check(response, { [`${label}: status 2xx`]: (result) => result.status >= 200 && result.status < 300 });
  let bodyOk = transportOk;
  if (transportOk && validate) {
    try {
      bodyOk = validate(response.json());
    } catch (_) {
      bodyOk = false;
    }
    check(bodyOk, { [`${label}: valid response`]: (value) => value === true });
  }
  businessErrors.add(!(transportOk && bodyOk), { operation: label });
  return transportOk && bodyOk;
};

const shortIdAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const recordId = (index) => {
  let remaining = manifest.recordShortIdStart + index - 1;
  let id = "";
  for (let power = 5; power >= 0; power--) {
    const divisor = shortIdAlphabet.length ** power;
    id += shortIdAlphabet[Math.floor(remaining / divisor)];
    remaining %= divisor;
  }
  return id;
};

export function readFlow() {
  const roll = Math.random();
  if (readOperation === "table" || (readOperation === "mixed" && roll < 0.4)) {
    const source = `from table {${manifest.tables.items}}\nwhere {${manifest.fields.status}} = 'Available'\nsort {${manifest.fields.purchaseDate}} desc nulls last\nlimit 50`;
    const first = jsonRequest("POST", `/api/grids/tables/${manifest.tables.items}/query`, { source }, { operation: "table-list" });
    if (responseOk(first, "table-list", (body) => Array.isArray(body.items))) {
      const cursor = first.json().nextCursor;
      if (cursor) {
        const second = jsonRequest(
          "POST",
          `/api/grids/tables/${manifest.tables.items}/query`,
          { source, cursor },
          { operation: "table-page" },
        );
        responseOk(second, "table-page", (body) => Array.isArray(body.items));
      }
    }
  } else if (readOperation === "gql-search" || (readOperation === "mixed" && roll < 0.7)) {
    const query = `from table {${manifest.tables.items}}\nsearch 'needle' in {${manifest.fields.name}}\nsort {${manifest.fields.assetId}} asc\nlimit 50`;
    const response = jsonRequest(
      "POST",
      `/api/grids/gql/by-base/${manifest.baseId}/execute`,
      { query, pageSize: 50, surface: "api" },
      { operation: "gql-search" },
    );
    responseOk(response, "gql-search", (body) => body.ok === true && Array.isArray(body.rows));
  } else {
    const query = `from table {${manifest.tables.items}}\ngroup by {${manifest.fields.status}}\naggregate count(*) as rows, sum({${manifest.fields.replacementValue}}) as value\nsort value desc\nlimit 20`;
    const response = jsonRequest(
      "POST",
      `/api/grids/gql/by-base/${manifest.baseId}/execute`,
      { query, pageSize: 20, surface: "api" },
      { operation: "gql-group" },
    );
    responseOk(response, "gql-group", (body) => body.ok === true && body.mode === "groups" && Array.isArray(body.rows));
  }
  sleep(0.05);
}

export function writeFlow() {
  const index = ((__VU * 7919 + __ITER) % manifest.rows) + 1;
  const id = recordId(index);
  const loaded = jsonRequest("GET", `/api/grids/records/${manifest.tables.items}/${id}`, undefined, { operation: "record-get" });
  if (!responseOk(loaded, "record-get", (body) => body.id === id && Number.isInteger(body.version))) return;
  const version = loaded.json().version;
  const response = http.patch(
    `${baseUrl}/api/grids/records/${manifest.tables.items}/${id}`,
    JSON.stringify({ values: { [manifest.fields.notes]: `Load write ${__VU}:${__ITER}:${Date.now()}` } }),
    { headers: { ...headers(), "if-match": String(version) }, tags: { operation: "record-update" }, timeout: "30s" },
  );
  responseOk(response, "record-update", (body) => body.id === id && body.version === version + 1);
}

export function workflowFlow() {
  const response = jsonRequest(
    "POST",
    `/api/grids/workflows/${manifest.workflowId}/invoke`,
    { mode: "execute", inputs: {}, idempotencyKey: `load-${profile}-${__VU}-${__ITER}-${Date.now()}` },
    { operation: "workflow-invoke" },
  );
  responseOk(response, "workflow-invoke", (body) => typeof body.runId === "string" || typeof body.id === "string");
  sleep(1);
}

export function liveFlow() {
  const socketUrl = `${baseUrl.replace(/^http/, "ws")}/api/grids/ws`;
  const response = ws.connect(socketUrl, { tags: { operation: "records-live" } }, (socket) => {
    let ready = false;
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "grids.records.subscribe",
          payload: { tableId: manifest.tables.items, sessionToken: manifest.sessionToken, fromCursor: null },
        }),
      );
    });
    socket.on("message", (message) => {
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === "grids.records.ready") ready = true;
        if (parsed.type === "grids.records.error" || parsed.type === "grids.records.revoked")
          businessErrors.add(true, { operation: "records-live" });
      } catch (_) {
        businessErrors.add(true, { operation: "records-live" });
      }
    });
    socket.setTimeout(() => {
      check(ready, { "records-live: ready": (value) => value === true });
      businessErrors.add(!ready, { operation: "records-live" });
      socket.close();
    }, 3_000);
  });
  check(response, { "records-live: upgraded": (result) => result && result.status === 101 });
  sleep(0.2);
}

export function pdfFlow() {
  const response = jsonRequest(
    "POST",
    `/api/grids/documents/templates/${manifest.documentTemplateId}/generate`,
    { recordId: manifest.documentRecordId, tags: ["load-test"] },
    { operation: "pdf-generate" },
    "none",
  );
  responseOk(response, "pdf-generate");
}

export function handleSummary(data) {
  return {
    stdout: `\nGrids ${profile}: ${data.metrics.http_reqs?.values?.count || 0} requests, p95 ${Math.round(data.metrics.http_req_duration?.values?.["p(95)"] || 0)}ms\n`,
    "/results/k6-summary.json": JSON.stringify(data, null, 2),
  };
}
