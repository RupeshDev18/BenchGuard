#!/usr/bin/env node
/**
 * generate-allure.js
 *
 * Converts k6 metrics (k6-summary.json) and optional contract results (contract-summary.json)
 * into standard Allure 2 results (allure-results/), and invokes the Allure CLI
 * to generate a comprehensive, interactive Allure HTML report.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const crypto = require("crypto");

function getArg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const configPath = path.resolve(process.cwd(), getArg("config", "config.json"));
const k6Path = path.resolve(process.cwd(), getArg("k6", "report-output/k6-summary.json"));
const contractPath = getArg("contract", null) ? path.resolve(process.cwd(), getArg("contract")) : null;
const resultsDir = path.resolve(process.cwd(), getArg("results", "report-output/allure-results"));
const reportDir = path.resolve(process.cwd(), getArg("out", "report-output/allure-report"));

if (!fs.existsSync(configPath)) {
  console.error(`[generate-allure] Config file not found at: ${configPath}`);
  process.exit(1);
}

if (!fs.existsSync(k6Path)) {
  console.error(`[generate-allure] k6 summary JSON not found at: ${k6Path}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const k6Summary = JSON.parse(fs.readFileSync(k6Path, "utf8"));

let contractSummary = null;
if (contractPath && fs.existsSync(contractPath)) {
  try {
    contractSummary = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  } catch (err) {
    console.warn(`[generate-allure] Warning: Could not parse contract summary at ${contractPath}:`, err.message);
  }
}

// Preserve existing history if available for Allure trend tracking
const historyBackupDir = path.join(reportDir, "history");
const historyDestDir = path.join(resultsDir, "history");
let hasHistory = false;
if (fs.existsSync(historyBackupDir)) {
  try {
    if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
    fs.cpSync(historyBackupDir, historyDestDir, { recursive: true });
    hasHistory = true;
    console.log("[generate-allure] Preserved historical data for trend charts.");
  } catch (err) {
    console.warn("[generate-allure] Notice: Failed copying history:", err.message);
  }
}

// Ensure clean results directory
if (!fs.existsSync(resultsDir)) {
  fs.mkdirSync(resultsDir, { recursive: true });
} else {
  // Clear non-history files
  const files = fs.readdirSync(resultsDir);
  for (const f of files) {
    if (f !== "history") {
      fs.rmSync(path.join(resultsDir, f), { recursive: true, force: true });
    }
  }
}

// Helper: safe metric values
function getMetric(name) {
  const m = k6Summary.metrics && k6Summary.metrics[name];
  if (!m) return {};
  return m.values ? { ...m, ...m.values } : m;
}

const reqDuration = getMetric("http_req_duration");
const reqFailed = getMetric("http_req_failed");
const reqCount = getMetric("http_reqs");
const vusMax = getMetric("vus_max");
const iterations = getMetric("iterations");

const startTime = Date.now() - Math.round((iterations.count || 10) * 1000);
const endTime = Date.now();

// 1. Write environment.properties
const envProps = [
  `Project=${config.run?.projectName || "Service API"}`,
  `Environment=${config.run?.environment || "staging"}`,
  `BuildLabel=${config.run?.buildLabel || "manual-run"}`,
  `ExecutedBy=${config.run?.executedBy || "Performance Pipeline"}`,
  `TargetBaseURL=${config.baseUrl || "http://localhost:8080"}`,
  `OpenAPISpec=${config.openapiPath || "openapi.json"}`,
  `PeakVUs=${vusMax.value ?? "N/A"}`,
  `TotalRequests=${reqCount.count ?? 0}`,
  `P95LatencyMs=${(reqDuration["p(95)"] || 0).toFixed(2)} ms`,
  `P99LatencyMs=${(reqDuration["p(99)"] || 0).toFixed(2)} ms`,
  `ErrorRate=${((reqFailed.rate || 0) * 100).toFixed(2)}%`,
  `DistributedTracing=${config.tracing !== false ? "Enabled (W3C traceparent)" : "Disabled"}`,
  `APMProvider=${config.apmProvider || "OpenTelemetry / Generic"}`,
  `APMTraceURLTemplate=${config.apmUrlTemplate || "http://localhost:16686/trace/{traceId}"}`,
].join("\n");

fs.writeFileSync(path.join(resultsDir, "environment.properties"), envProps, "utf8");

// Load captured sample traces if available
let sampleTraces = [];
const sampleTracesPath = path.join(path.dirname(k6Path), "sample-traces.json");
if (fs.existsSync(sampleTracesPath)) {
  try {
    sampleTraces = JSON.parse(fs.readFileSync(sampleTracesPath, "utf8"));
  } catch (_) {}
}

// 2. Write categories.json (Defect & Failure classification)
const categories = [
  {
    name: "SLA Threshold Violations (P95 / P99 Latency)",
    matchedStatuses: ["failed"],
    messageRegex: ".*(threshold|SLA|p95|p99|latency).*",
  },
  {
    name: "High Failure Rate (> SLA %)",
    matchedStatuses: ["failed"],
    messageRegex: ".*(fail rate|error rate|status < 400).*",
  },
  {
    name: "Contract Schema Validation Mismatches",
    matchedStatuses: ["failed", "broken"],
    messageRegex: ".*(schema|contract|schemathesis).*",
  },
];
fs.writeFileSync(path.join(resultsDir, "categories.json"), JSON.stringify(categories, null, 2), "utf8");

// 3. Write executor.json
const executor = {
  name: "k6 Performance Runner",
  type: "k6",
  reportName: `Performance Run - ${config.run?.buildLabel || "Build"}`,
  buildName: config.run?.buildLabel || "Local Execution",
  environment: config.run?.environment || "staging",
};
fs.writeFileSync(path.join(resultsDir, "executor.json"), JSON.stringify(executor, null, 2), "utf8");

// 4. Map Per-Endpoint and Global Threshold Metrics into Allure Test Cases
// Check for threshold status from k6 summary
const thresholdMap = new Map();
for (const [metricName, m] of Object.entries(k6Summary.metrics || {})) {
  if (m.thresholds) {
    for (const [expr, res] of Object.entries(m.thresholds)) {
      const isOk = typeof res === "object" && res !== null ? !!res.ok : res === false;
      thresholdMap.set(`${metricName}::${expr}`, { ok: isOk, metricName, expr });
    }
  }
}

// Find endpoints tested from metrics
const endpointMetricPrefix = "http_req_duration{endpoint:";
const detectedEndpoints = new Set();
for (const metricKey of Object.keys(k6Summary.metrics || {})) {
  if (metricKey.startsWith(endpointMetricPrefix)) {
    const epName = metricKey.slice(endpointMetricPrefix.length, -1);
    detectedEndpoints.add(epName);
  }
}

// If no tagged endpoints found in keys, fallback to groups or checks
if (detectedEndpoints.size === 0) {
  for (const [key] of Object.entries(k6Summary.root_group?.checks || {})) {
    const parts = key.split(" ");
    if (parts.length > 0) detectedEndpoints.add(parts[0]);
  }
}

// Global System SLA Test Case
const globalP95Threshold = config.thresholds?.p95Ms || 500;
const globalP99Threshold = config.thresholds?.p99Ms || 1000;
const globalMaxErrorRate = config.thresholds?.maxErrorRate ?? 0.01;

const actualP95 = reqDuration["p(95)"] || 0;
const actualP99 = reqDuration["p(99)"] || 0;
const actualErrorRate = reqFailed.rate || 0;

const p95Pass = actualP95 <= globalP95Threshold;
const p99Pass = actualP99 <= globalP99Threshold;
const errorRatePass = actualErrorRate <= globalMaxErrorRate;
const globalPassed = p95Pass && p99Pass && errorRatePass;

// Write Global System Load & SLA Test Case
const globalUuid = crypto.randomUUID();
const globalAttachmentName = `k6-summary-${globalUuid}.json`;
fs.writeFileSync(
  path.join(resultsDir, globalAttachmentName),
  JSON.stringify(k6Summary, null, 2),
  "utf8"
);

const globalTestCase = {
  uuid: globalUuid,
  historyId: crypto.createHash("md5").update("Global-System-SLA").digest("hex"),
  fullName: "Performance Load Tests.Global System SLA Compliance",
  name: "Global System SLA & Throughput Thresholds",
  status: globalPassed ? "passed" : "failed",
  statusDetails: globalPassed
    ? { message: "All system-wide SLA thresholds met successfully." }
    : {
        message: `SLA Threshold Failure: P95=${actualP95.toFixed(2)}ms (Limit: ${globalP95Threshold}ms), P99=${actualP99.toFixed(2)}ms (Limit: ${globalP99Threshold}ms), ErrorRate=${(actualErrorRate * 100).toFixed(2)}% (Limit: ${(globalMaxErrorRate * 100).toFixed(2)}%)`,
      },
  stage: "finished",
  start: startTime,
  stop: endTime,
  description: `Validates overall system load thresholds under maximum concurrency (${vusMax.value ?? 0} VUs) and total ${reqCount.count ?? 0} HTTP requests.`,
  parameters: [
    { name: "Total Requests", value: String(reqCount.count ?? 0) },
    { name: "Requests/sec", value: (reqCount.rate || 0).toFixed(2) },
    { name: "Peak Concurrency (VUs)", value: String(vusMax.value ?? 0) },
    { name: "P95 Latency", value: `${actualP95.toFixed(2)} ms` },
    { name: "P99 Latency", value: `${actualP99.toFixed(2)} ms` },
    { name: "Error Rate", value: `${(actualErrorRate * 100).toFixed(2)}%` },
  ],
  steps: [
    {
      name: `Check P95 Latency (${actualP95.toFixed(2)} ms < ${globalP95Threshold} ms)`,
      status: p95Pass ? "passed" : "failed",
      stage: "finished",
      start: startTime,
      stop: startTime + 100,
    },
    {
      name: `Check P99 Latency (${actualP99.toFixed(2)} ms < ${globalP99Threshold} ms)`,
      status: p99Pass ? "passed" : "failed",
      stage: "finished",
      start: startTime + 100,
      stop: startTime + 200,
    },
    {
      name: `Check Error Rate (${(actualErrorRate * 100).toFixed(2)}% < ${(globalMaxErrorRate * 100).toFixed(2)}%)`,
      status: errorRatePass ? "passed" : "failed",
      stage: "finished",
      start: startTime + 200,
      stop: startTime + 300,
    },
  ],
  attachments: [
    {
      name: "Complete k6 Summary JSON",
      source: globalAttachmentName,
      type: "application/json",
    },
    ...(sampleTraces.length > 0 ? (() => {
      const traceAttachName = `sample-traces-${globalUuid}.json`;
      fs.writeFileSync(path.join(resultsDir, traceAttachName), JSON.stringify(sampleTraces, null, 2), "utf8");
      return [{
        name: "Captured Distributed Traces (W3C traceparent)",
        source: traceAttachName,
        type: "application/json"
      }];
    })() : [])
  ],
  labels: [
    { name: "suite", value: "Performance Load Tests" },
    { name: "subSuite", value: "Executive System SLAs" },
    { name: "epic", value: config.run?.projectName || "API Service" },
    { name: "feature", "value": "System Scalability" },
    { name: "severity", value: "blocker" },
  ],
};

fs.writeFileSync(
  path.join(resultsDir, `${globalUuid}-result.json`),
  JSON.stringify(globalTestCase, null, 2),
  "utf8"
);

// 5. Generate Individual Test Cases for each Endpoint
for (const opId of detectedEndpoints) {
  const metricKey = `http_req_duration{endpoint:${opId}}`;
  const rawEp = k6Summary.metrics && k6Summary.metrics[metricKey];
  const epMetric = rawEp ? (rawEp.values ? { ...rawEp, ...rawEp.values } : rawEp) : {};

  const epP90 = epMetric["p(90)"] || actualP95;
  const epP95 = epMetric["p(95)"] || actualP95;
  const epP99 = epMetric["p(99)"] || actualP99;
  const epAvg = epMetric.avg || reqDuration.avg || 0;

  // Evaluate endpoint specific threshold
  let epPassed = true;
  let epFailureMsg = "";

  for (const [threshKey, threshRes] of thresholdMap.entries()) {
    if (threshKey.includes(`endpoint:${opId}`) && !threshRes.ok) {
      epPassed = false;
      epFailureMsg += `Threshold ${threshRes.expr} breached. `;
    }
  }

  // Also check check failures for this endpoint
  let checksPassed = 0;
  let checksFailed = 0;
  for (const [chkName, chkObj] of Object.entries(k6Summary.root_group?.checks || {})) {
    if (chkName.includes(opId)) {
      checksPassed += chkObj.passes || 0;
      checksFailed += chkObj.fails || 0;
    }
  }
  if (checksFailed > 0) {
    epPassed = false;
    epFailureMsg += `${checksFailed} response validation checks failed. `;
  }

  const epUuid = crypto.randomUUID();
  const epAttachmentName = `endpoint-${opId}-${epUuid}.json`;

  const epBreakdown = {
    operationId: opId,
    endpointThresholdPassed: epPassed,
    latencies: {
      averageMs: epAvg,
      p90Ms: epP90,
      p95Ms: epP95,
      p99Ms: epP99,
      minMs: epMetric.min || 0,
      maxMs: epMetric.max || 0,
    },
    checks: {
      passed: checksPassed,
      failed: checksFailed,
    },
  };

  fs.writeFileSync(
    path.join(resultsDir, epAttachmentName),
    JSON.stringify(epBreakdown, null, 2),
    "utf8"
  );

  const epTestCase = {
    uuid: epUuid,
    historyId: crypto.createHash("md5").update(`Endpoint-${opId}`).digest("hex"),
    fullName: `Endpoint Tests.${opId}`,
    name: `API Endpoint: ${opId}`,
    status: epPassed ? "passed" : "failed",
    statusDetails: epPassed
      ? { message: `Endpoint SLA passed (P95: ${epP95.toFixed(2)} ms)` }
      : { message: epFailureMsg || `P95 response time (${epP95.toFixed(2)} ms) exceeded target.` },
    stage: "finished",
    start: startTime,
    stop: endTime,
    description: `Automated load test verification for endpoint operation: ${opId}`,
    parameters: [
      { name: "Operation ID", value: opId },
      { name: "Avg Latency", value: `${epAvg.toFixed(2)} ms` },
      { name: "P90 Latency", value: `${epP90.toFixed(2)} ms` },
      { name: "P95 Latency", value: `${epP95.toFixed(2)} ms` },
      { name: "P99 Latency", value: `${epP99.toFixed(2)} ms` },
      { name: "Checks Passed", value: String(checksPassed) },
      { name: "Checks Failed", value: String(checksFailed) },
    ],
    steps: [
      {
        name: `HTTP Request execution under concurrency`,
        status: "passed",
        stage: "finished",
        start: startTime,
        stop: startTime + 50,
      },
      {
        name: `HTTP 2xx/3xx Status Validation`,
        status: checksFailed === 0 ? "passed" : "failed",
        stage: "finished",
        start: startTime + 50,
        stop: startTime + 100,
      },
      {
        name: `Endpoint P95 Latency Verification (${epP95.toFixed(2)} ms)`,
        status: epPassed ? "passed" : "failed",
        stage: "finished",
        start: startTime + 100,
        stop: startTime + 150,
      },
    ],
    attachments: [
      {
        name: `Performance Metrics for ${opId}`,
        source: epAttachmentName,
        type: "application/json",
      },
    ],
    links: sampleTraces
      .filter((t) => t.endpoint === opId)
      .slice(0, 3)
      .map((t) => ({
        name: `APM Trace (${config.apmProvider || "OpenTelemetry"}): ${t.traceId.slice(0, 8)}...`,
        url: t.apmUrl,
        type: "custom",
      })),
    labels: [
      { name: "suite", value: "API Endpoints Performance" },
      { name: "subSuite", value: opId },
      { name: "epic", value: config.run?.projectName || "API Service" },
      { name: "feature", value: "Endpoint Latency Compliance" },
      { name: "severity", value: "critical" },
    ],
  };

  fs.writeFileSync(
    path.join(resultsDir, `${epUuid}-result.json`),
    JSON.stringify(epTestCase, null, 2),
    "utf8"
  );
}

// 6. If Schemathesis contract results exist, add them to Allure
if (contractSummary) {
  const contractPassed = (contractSummary.failed || 0) === 0;
  const contractUuid = crypto.randomUUID();
  const contractAttachName = `contract-summary-${contractUuid}.json`;

  fs.writeFileSync(
    path.join(resultsDir, contractAttachName),
    JSON.stringify(contractSummary, null, 2),
    "utf8"
  );

  const contractSteps = (contractSummary.failures || []).map((f) => ({
    name: `Contract Violation on ${f.endpoint}`,
    status: "failed",
    statusDetails: { message: f.reason },
    stage: "finished",
  }));

  const contractTestCase = {
    uuid: contractUuid,
    historyId: crypto.createHash("md5").update("Contract-Validation-Schemathesis").digest("hex"),
    fullName: "Contract Testing.Schemathesis Schema Compliance",
    name: "OpenAPI Schema Contract Compliance (Schemathesis)",
    status: contractPassed ? "passed" : "failed",
    statusDetails: contractPassed
      ? { message: `All ${contractSummary.total || 0} API contract checks conformed to OpenAPI schema.` }
      : { message: `${contractSummary.failed} endpoint schema violations detected.` },
    stage: "finished",
    start: startTime,
    stop: endTime,
    description: "Validates that live API responses strictly conform to schemas and types declared in openapi.json.",
    parameters: [
      { name: "Total Operations Tested", value: String(contractSummary.total || 0) },
      { name: "Contracts Passed", value: String(contractSummary.passed || 0) },
      { name: "Contracts Failed", value: String(contractSummary.failed || 0) },
    ],
    steps: contractSteps.length > 0 ? contractSteps : [
      {
        name: `All ${contractSummary.total || 0} OpenAPI response contracts valid`,
        status: "passed",
        stage: "finished",
      },
    ],
    attachments: [
      {
        name: "Schemathesis Contract Results",
        source: contractAttachName,
        type: "application/json",
      },
    ],
    labels: [
      { name: "suite", value: "Contract Validation (Schemathesis)" },
      { name: "epic", value: config.run?.projectName || "API Service" },
      { name: "feature", value: "OpenAPI Schema Validation" },
      { name: "severity", value: "normal" },
    ],
  };

  fs.writeFileSync(
    path.join(resultsDir, `${contractUuid}-result.json`),
    JSON.stringify(contractTestCase, null, 2),
    "utf8"
  );
}

console.log(`[generate-allure] Successfully emitted Allure 2 test results -> ${resultsDir}`);

// 7. Invoke Allure CLI to generate HTML Report
try {
  console.log(`[generate-allure] Compiling Allure report via allure-commandline...`);
  // Try npx allure-commandline generate
  const cmd = `npx allure-commandline generate "${resultsDir}" --clean -o "${reportDir}"`;
  execSync(cmd, { stdio: "inherit" });
  console.log(`[generate-allure] Allure report successfully generated at: ${reportDir}`);
} catch (err) {
  console.error(`[generate-allure] Warning: Allure generation encountered an issue: ${err.message}`);
  console.error(`[generate-allure] You can run 'npx allure-commandline generate "${resultsDir}" --clean -o "${reportDir}"' manually.`);
}
