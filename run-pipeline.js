#!/usr/bin/env node
/**
 * run-pipeline.js
 *
 * Cross-platform Master Test Orchestrator
 * End-to-end pipeline:
 * 1. Generates k6 script from OpenAPI specification.
 * 2. Runs k6 load testing with SLA assertions & metrics export.
 * 3. Runs contract checks via Schemathesis (if enabled).
 * 4. Compiles Allure 2 results and builds interactive Allure HTML report.
 * 5. Generates the Executive Management HTML report.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function getArg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const configArg = getArg("config", process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "config.json");
const configPath = path.resolve(process.cwd(), configArg);
const outDir = path.resolve(process.cwd(), getArg("out", "report-output"));

console.log("\n==================================================================");
console.log(" 🚀 STARTING OPENAPI LOAD & PERFORMANCE TEST PIPELINE");
console.log("==================================================================");
console.log(` Config  : ${configPath}`);
console.log(` Output  : ${outDir}\n`);

if (!fs.existsSync(configPath)) {
  console.error(`[pipeline] Error: Config file not found: ${configPath}`);
  process.exit(1);
}

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

function runStep(title, command, args) {
  console.log(`\n------------------------------------------------------------------`);
  console.log(`[PIPELINE STEP] ${title}`);
  // Quote arguments containing spaces if not already quoted
  const sanitizedArgs = args.map((a) => {
    if ((a.startsWith('"') && a.endsWith('"')) || !a.includes(" ")) return a;
    return `"${a}"`;
  });
  console.log(`$ ${command} ${sanitizedArgs.join(" ")}`);
  console.log(`------------------------------------------------------------------`);
  const result = spawnSync(command, sanitizedArgs, {
    stdio: "inherit",
    shell: true,
    cwd: __dirname,
  });
  return result;
}

// 1. Generate k6 script
const loadtestScript = path.join(outDir, "loadtest.js");
const genResult = runStep(
  "1/5 Generating k6 script from OpenAPI specification",
  "node",
  [path.join(__dirname, "src/generator/generate-k6.js"), "--config", configPath, "--out", loadtestScript]
);

if (genResult.status !== 0) {
  console.error("\n❌ Pipeline failed during k6 script generation.");
  process.exit(genResult.status || 1);
}

// 2. Run k6 load test
const summaryJson = path.join(outDir, "k6-summary.json");
const k6Result = runStep(
  "2/5 Executing k6 Load Test",
  "k6",
  ["run", `--summary-export=${summaryJson}`, loadtestScript]
);

// Note: k6 returns code 99 if thresholds failed, but we still want to generate reports!
const k6ThresholdFailed = k6Result.status !== 0;
if (k6ThresholdFailed) {
  console.warn("\n⚠️  k6 thresholds failed or k6 exited with non-zero code. Continuing to generate reports.");
}

// 3. Run Schemathesis contract checks (if enabled)
const contractSummary = path.join(outDir, "contract-summary.json");
runStep(
  "3/5 Checking API Contracts (Schemathesis)",
  "node",
  [path.join(__dirname, "src/contract/run-contract.js"), "--config", configPath, "--out", outDir]
);

const hasContract = fs.existsSync(contractSummary);
const contractArgs = hasContract ? ["--contract", contractSummary] : [];

// 4. Generate Allure Report
const allureResultsDir = path.join(outDir, "allure-results");
const allureReportDir = path.join(outDir, "allure-report");
runStep(
  "4/5 Generating Allure 2 Report",
  "node",
  [
    path.join(__dirname, "src/allure/generate-allure.js"),
    "--config", configPath,
    "--k6", summaryJson,
    ...contractArgs,
    "--results", allureResultsDir,
    "--out", allureReportDir,
  ]
);

// 5. Generate Executive Management HTML Report
const managementReport = path.join(outDir, "report.html");
runStep(
  "5/5 Compiling Executive Management HTML Report",
  "node",
  [
    path.join(__dirname, "src/reports/generate-management-report.js"),
    "--config", configPath,
    "--k6", summaryJson,
    ...contractArgs,
    "--out", managementReport,
  ]
);

// 6. Record Run to History
try {
  const historyFile = path.join(outDir, "runs-history.json");
  const summary = JSON.parse(fs.readFileSync(summaryJson, "utf8"));
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

  const getM = (name) => {
    const m = summary.metrics?.[name];
    if (!m) return {};
    return m.values ? { ...m, ...m.values } : m;
  };

  const dur = getM("http_req_duration");
  const reqs = getM("http_reqs");
  const failed = getM("http_req_failed");
  const failedRate = failed.value !== undefined ? failed.value : (failed.rate !== undefined ? failed.rate : (failed.passes && (failed.passes + (failed.fails || 0)) > 0 ? (failed.passes / (failed.passes + (failed.fails || 0))) : 0));
  const vus = getM("vus_max");

  const record = {
    id: Date.now(),
    date: new Date().toISOString(),
    buildLabel: config.run?.buildLabel || "build",
    environment: config.run?.environment || "staging",
    exitCode: k6ThresholdFailed ? 1 : 0,
    passed: !k6ThresholdFailed,
    p95: dur["p(95)"] || 0,
    p99: dur["p(99)"] || 0,
    avg: dur.avg || 0,
    throughput: reqs.rate || 0,
    totalRequests: reqs.count || 0,
    errorRate: (failedRate * 100).toFixed(2),
    peakVus: vus.value || 0,
  };

  let history = [];
  if (fs.existsSync(historyFile)) {
    try { history = JSON.parse(fs.readFileSync(historyFile, "utf8")); } catch (e) {}
  }
  history.unshift(record);
  if (history.length > 30) history = history.slice(0, 30);
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2), "utf8");
} catch (err) {
  console.warn(`[pipeline] Warning: Failed to record run history: ${err.message}`);
}

console.log("\n==================================================================");
console.log(" 🎉 PIPELINE COMPLETED SUCCESSFULLY!");
console.log("==================================================================");
console.log(` 📊 Executive Report  : ${managementReport}`);
console.log(` 🔍 Allure Deep-Dive  : ${path.join(allureReportDir, "index.html")}`);
console.log(` 📈 Raw k6 Summary    : ${summaryJson}`);
console.log("==================================================================\n");

// If k6 thresholds failed, exit with 1 for CI/CD gating if desired
if (k6ThresholdFailed) {
  process.exit(1);
}
