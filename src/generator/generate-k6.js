#!/usr/bin/env node
/**
 * generate-k6.js
 *
 * Converts an OpenAPI 3.x specification and run config into a production-grade
 * k6 load test script with granular endpoint tagging, dynamic payload resolution,
 * per-VU uniqueness, custom status code expectations, dataset feeding (SharedArray),
 * SLA thresholds, and authentication.
 */

const fs = require("fs");
const path = require("path");

function getArg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const configPath = path.resolve(process.cwd(), getArg("config", "config.json"));
const outPath = path.resolve(process.cwd(), getArg("out", "report-output/loadtest.js"));

if (!fs.existsSync(configPath)) {
  console.error(`[generate-k6] Config file not found at: ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const openapiFile = path.resolve(path.dirname(configPath), config.openapiPath);

if (!fs.existsSync(openapiFile)) {
  console.error(`[generate-k6] OpenAPI file not found at: ${openapiFile}`);
  process.exit(1);
}

const openapi = JSON.parse(fs.readFileSync(openapiFile, "utf8"));
const baseUrl = config.baseUrl || (openapi.servers && openapi.servers[0] && openapi.servers[0].url) || "http://localhost:8080";

// Ensure destination folder exists
const outDir = path.dirname(outPath);
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// ---------- Recursive $ref resolution ----------
const refCache = new Map();
function resolveRef(ref, visited = new Set()) {
  if (refCache.has(ref)) return refCache.get(ref);
  if (visited.has(ref)) return {}; // Prevent circular loops
  visited.add(ref);

  const parts = ref.replace(/^#\//, "").split("/");
  let curr = openapi;
  for (const part of parts) {
    if (!curr || typeof curr !== "object") return {};
    curr = curr[part];
  }
  refCache.set(ref, curr);
  return curr;
}

// ---------- Realistic sample generation from Schema with smart uniqueness ----------
function generateValueFromSchema(schema, depth = 0, keyName = "") {
  if (!schema || depth > 6) return "test";
  if (schema.$ref) return generateValueFromSchema(resolveRef(schema.$ref), depth + 1, keyName);

  const lowerKey = keyName.toLowerCase();

  // Smart dynamic templates for unique entities in load tests
  if (lowerKey.includes("email") || schema.format === "email") return "user_{{$vu}}_{{$timestamp}}@example.com";
  if (lowerKey === "sku" || lowerKey.endsWith("sku")) return "SKU-{{$vu}}-{{$timestamp}}";
  if (lowerKey === "username" || lowerKey === "user_name") return "user_{{$vu}}_{{$timestamp}}";
  if (lowerKey === "customerid" || lowerKey === "customer_id") return "CUST-{{$vu}}";
  if (lowerKey === "ordernumber" || lowerKey === "orderid") return "ORD-{{$vu}}-{{$timestamp}}";

  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  if (schema.allOf) {
    let merged = {};
    for (const sub of schema.allOf) {
      const val = generateValueFromSchema(sub, depth + 1, keyName);
      if (typeof val === "object" && val !== null) Object.assign(merged, val);
    }
    return merged;
  }

  if (schema.anyOf && schema.anyOf.length) return generateValueFromSchema(schema.anyOf[0], depth + 1, keyName);
  if (schema.oneOf && schema.oneOf.length) return generateValueFromSchema(schema.oneOf[0], depth + 1, keyName);

  const type = schema.type || (schema.properties ? "object" : "string");

  switch (type) {
    case "object": {
      const obj = {};
      const props = schema.properties || {};
      for (const [key, propDef] of Object.entries(props)) {
        obj[key] = generateValueFromSchema(propDef, depth + 1, key);
      }
      return obj;
    }
    case "array": {
      const itemSchema = schema.items || {};
      return [generateValueFromSchema(itemSchema, depth + 1, keyName)];
    }
    case "integer":
      return schema.format === "int64" ? 1001 : 42;
    case "number":
      return 99.95;
    case "boolean":
      return true;
    case "string":
      if (schema.format === "date-time") return "{{$timestamp}}";
      if (schema.format === "date") return "2026-09-16";
      if (schema.format === "uuid") return "{{$randomUUID}}";
      if (lowerKey.includes("name")) return "Item-{{$vu}}-{{$timestamp}}";
      return "sample_value";
    default:
      return "data";
  }
}

// ---------- Dataset (CSV / JSON) configuration ----------
let datasetSnippet = "";
let hasDataset = false;
const datasetPath = config.datasetPath || (config.dataset && config.dataset.path);

if (datasetPath && fs.existsSync(datasetPath)) {
  const resolvedDataset = path.resolve(datasetPath).replace(/\\/g, "/");
  hasDataset = true;
  datasetSnippet = `
import { SharedArray } from "k6/data";
import papaparse from "https://jslib.k6.io/papaparse/5.1.1/index.js";

const dataset = new SharedArray("User Test Data", function () {
  const fileContent = open("${resolvedDataset}");
  if ("${resolvedDataset}".endsWith(".csv")) {
    return papaparse.parse(fileContent, { header: true }).data;
  }
  return JSON.parse(fileContent);
});
`;
}

// ---------- Walk paths and gather endpoints ----------
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];
const endpoints = [];
const epConfigs = config.endpointConfigs || {};

for (const [route, pathItem] of Object.entries(openapi.paths || {})) {
  for (const method of HTTP_METHODS) {
    const op = pathItem[method];
    if (!op) continue;

    const opId = op.operationId || `${method}_${route.replace(/[^a-zA-Z0-9]/g, "_")}`;

    // Filter endpoints
    if (config.endpoints?.exclude?.includes(opId)) continue;
    if (
      config.endpoints?.include &&
      !config.endpoints.include.includes("all") &&
      !config.endpoints.include.includes(opId)
    ) {
      continue;
    }

    // Resolve path parameters
    let resolvedRoute = route;
    const allParams = [...(pathItem.parameters || []), ...(op.parameters || [])];
    const pathParams = allParams.filter((p) => p.in === "path");
    const queryParams = allParams.filter((p) => p.in === "query");

    for (const p of pathParams) {
      const pSchema = p.schema || {};
      const pVal = p.example ?? pSchema.example ?? (pSchema.type === "integer" ? 101 : "sample-id");
      resolvedRoute = resolvedRoute.replace(`{${p.name}}`, encodeURIComponent(pVal));
    }

    // Resolve query parameters
    const queryStringParts = [];
    for (const q of queryParams) {
      if (q.required || q.example || q.schema?.example) {
        const val = q.example ?? q.schema?.example ?? (q.schema?.type === "integer" ? 10 : "default");
        queryStringParts.push(`${encodeURIComponent(q.name)}=${encodeURIComponent(val)}`);
      }
    }
    const finalRoute = queryStringParts.length > 0 ? `${resolvedRoute}?${queryStringParts.join("&")}` : resolvedRoute;

    // Check if user provided custom payload override in config
    const userEpConfig = epConfigs[opId] || {};
    let bodyPayload = null;

    if (userEpConfig.body !== undefined) {
      bodyPayload = userEpConfig.body;
    } else {
      const reqBody = op.requestBody;
      if (reqBody && reqBody.content) {
        const jsonContent = reqBody.content["application/json"] ||
                            reqBody.content["application/*+json"] ||
                            Object.values(reqBody.content)[0];
        if (jsonContent && jsonContent.schema) {
          bodyPayload = generateValueFromSchema(jsonContent.schema);
        }
      } else {
        const bodyParam = allParams.find((p) => p && p.in === "body");
        if (bodyParam && bodyParam.schema) {
          bodyPayload = generateValueFromSchema(bodyParam.schema);
        }
      }
    }

    // Custom status codes or default 2xx/3xx
    const expectedStatuses = userEpConfig.expectedStatus || (method.toLowerCase() === "post" ? [200, 201] : [200, 201, 204]);

    endpoints.push({
      opId,
      method: method.toUpperCase(),
      originalRoute: route,
      route: finalRoute,
      summary: op.summary || `${method.toUpperCase()} ${route}`,
      tag: (op.tags && op.tags[0]) || "General",
      body: bodyPayload,
      expectedStatuses,
    });
  }
}

if (endpoints.length === 0) {
  console.error("[generate-k6] ERROR: No endpoints matched include/exclude filters.");
  process.exit(1);
}

// ---------- Build Load Profile ----------
const load = config.load || { mode: "stages", stages: [{ duration: "10s", target: 10 }] };
let loadSnippet = "";
if (load.mode === "stages") {
  loadSnippet = `stages: ${JSON.stringify(load.stages, null, 4)},`;
} else {
  loadSnippet = `vus: ${load.vus || 10},\n  duration: "${load.duration || "30s"}",`;
}

// ---------- Build Thresholds with granular metrics ----------
const th = config.thresholds || {};
const p95 = th.p95Ms || 500;
const p99 = th.p99Ms || 1000;
const maxError = th.maxErrorRate ?? 0.01;

const thresholdRules = [
  `"http_req_duration": ["p(95)<${p95}", "p(99)<${p99}"]`,
  `"http_req_failed": ["rate<${maxError}"]`,
];

for (const ep of endpoints) {
  thresholdRules.push(`"http_req_duration{endpoint:${ep.opId}}": ["p(95)<${p95 * 1.5}"]`);
}

const thresholdsSnippet = `{\n    ${thresholdRules.join(",\n    ")}\n  }`;

// ---------- Headers & Authentication ----------
const customHeaders = config.headers || {};
if (!customHeaders["Content-Type"]) {
  customHeaders["Content-Type"] = "application/json";
}
const headersJson = JSON.stringify(customHeaders);

// ---------- Build k6 Request Statements ----------
const requestStatements = endpoints
  .map((ep) => {
    const urlExpr = `\`\${BASE_URL}${ep.route}\``;
    const paramsExpr = `{
      headers: HEADERS,
      tags: { endpoint: "${ep.opId}", tag: "${ep.tag}", route: "${ep.originalRoute}" }
    }`;

    const statusCheckList = JSON.stringify(ep.expectedStatuses);
    const statusCheckExpr = `[${ep.expectedStatuses.join(", ")}].includes(r.status)`;

    if (ep.method === "GET" || ep.method === "DELETE") {
      return `  // [${ep.tag}] ${ep.opId} - ${ep.summary}
  group("${ep.tag} - ${ep.opId}", function () {
    const res = http.${ep.method.toLowerCase()}(${urlExpr}, ${paramsExpr});
    check(res, {
      "${ep.opId} status in ${statusCheckList}": (r) => ${statusCheckExpr},
      "${ep.opId} p95 SLA acceptable": (r) => r.timings.duration < ${p95 * 2}
    });
  });`;
    }

    const payloadTemplate = JSON.stringify(ep.body || {});
    return `  // [${ep.tag}] ${ep.opId} - ${ep.summary}
  group("${ep.tag} - ${ep.opId}", function () {
    const rawPayload = ${payloadTemplate};
    const resolvedPayload = resolveDynamicValues(rawPayload, currentUser);
    const res = http.${ep.method.toLowerCase()}(${urlExpr}, JSON.stringify(resolvedPayload), ${paramsExpr});
    check(res, {
      "${ep.opId} status in ${statusCheckList}": (r) => ${statusCheckExpr},
      "${ep.opId} p95 SLA acceptable": (r) => r.timings.duration < ${p95 * 2}
    });
  });`;
  })
  .join("\n\n");

// ---------- Dynamic Resolver Function to Inject into k6 Script ----------
const resolverHelper = `
function resolveDynamicValues(val, user) {
  if (typeof val === "string") {
    return val
      .replace(/\\{\\{\\$randomEmail\\}\\}/g, "user_" + __VU + "_" + Date.now() + "_" + Math.floor(Math.random() * 1000) + "@example.com")
      .replace(/\\{\\{\\$randomUUID\\}\\}/g, "uuid-" + __VU + "-" + Math.random().toString(36).substring(2, 9) + "-" + Date.now())
      .replace(/\\{\\{\\$timestamp\\}\\}/g, String(Date.now()))
      .replace(/\\{\\{(\\$vu|__VU)\\}\\}/g, String(__VU))
      .replace(/\\{\\{(\\$iter|__ITER)\\}\\}/g, String(__ITER))
      .replace(/\\{\\{dataset\\.([a-zA-Z0-9_-]+)\\}\\}/g, function (_, key) {
        return user && user[key] !== undefined ? String(user[key]) : "val_" + __VU;
      });
  }
  if (Array.isArray(val)) {
    return val.map(function (item) { return resolveDynamicValues(item, user); });
  }
  if (val && typeof val === "object") {
    const res = {};
    for (const k in val) {
      res[k] = resolveDynamicValues(val[k], user);
    }
    return res;
  }
  return val;
}
`;

// ---------- Final Script Code ----------
const scriptContent = `// ====================================================================
// AUTO-GENERATED BY k6 OpenAPI Pipeline Generator
// Generated At : ${new Date().toISOString()}
// Source Spec  : ${config.openapiPath}
// Target URL   : ${baseUrl}
// Endpoints    : ${endpoints.length}
// ====================================================================

import http from "k6/http";
import { check, group, sleep } from "k6";
${datasetSnippet}

const BASE_URL = "${baseUrl}";
const HEADERS = ${headersJson};

${resolverHelper}

export const options = {
  ${loadSnippet}
  thresholds: ${thresholdsSnippet},
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
};

export default function () {
  const currentUser = ${hasDataset ? "dataset && dataset.length > 0 ? dataset[(__VU - 1) % dataset.length] : null" : "null"};

${requestStatements}

  sleep(0.5);
}
`;

fs.writeFileSync(outPath, scriptContent, "utf8");
console.log(`[generate-k6] Generated runnable script -> ${outPath}`);
console.log(`[generate-k6] Configured ${endpoints.length} endpoint(s):`);
endpoints.forEach((e) => {
  const hasCustom = epConfigs[e.opId] ? " (Custom Payload/Status)" : "";
  console.log(`  - [${e.method.padEnd(6)}] ${e.route.padEnd(35)} (${e.opId})${hasCustom}`);
});
