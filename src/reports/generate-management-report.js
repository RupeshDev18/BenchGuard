#!/usr/bin/env node
/**
 * generate-management-report.js
 *
 * Generates an executive management performance report in HTML format.
 * Features executive KPI cards, SLA compliance matrix, endpoint latency
 * percentiles, contract test results, and deep links to the Allure report.
 */

const fs = require("fs");
const path = require("path");

function getArg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const configPath = path.resolve(process.cwd(), getArg("config", "config.json"));
const k6Path = path.resolve(process.cwd(), getArg("k6", "report-output/k6-summary.json"));
const contractPath = getArg("contract", null) ? path.resolve(process.cwd(), getArg("contract")) : null;
const outPath = path.resolve(process.cwd(), getArg("out", "report-output/report.html"));

if (!fs.existsSync(configPath) || !fs.existsSync(k6Path)) {
  console.error("[generate-management-report] Missing required config or k6 summary file.");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const k6 = JSON.parse(fs.readFileSync(k6Path, "utf8"));

let contract = null;
if (contractPath && fs.existsSync(contractPath)) {
  try {
    contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  } catch (err) {
    console.warn("[generate-management-report] Failed to parse contract json:", err.message);
  }
}

// Ensure output directory exists
const outDir = path.dirname(outPath);
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// Helpers
function getMetric(name) {
  const m = k6.metrics && k6.metrics[name];
  if (!m) return {};
  return m.values ? { ...m, ...m.values } : m;
}

function fmt(n, decimals = 1) {
  if (typeof n !== "number" || isNaN(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

const dur = getMetric("http_req_duration");
const failed = getMetric("http_req_failed");
const reqs = getMetric("http_reqs");
const vusMax = getMetric("vus_max");

// Threshold evaluation
const thresholdResults = [];
for (const [metricName, m] of Object.entries(k6.metrics || {})) {
  if (!m.thresholds) continue;
  for (const [expr, res] of Object.entries(m.thresholds)) {
    // In k6 summary export, boolean false means breached: false (passed), true means breached (failed).
    // If it's an object, it has { ok: true/false }
    const isOk = typeof res === "object" && res !== null ? !!res.ok : res === false;
    thresholdResults.push({
      metricName,
      thresholdExpr: expr,
      ok: isOk,
    });
  }
}

const allThresholdsPassed = thresholdResults.every((t) => t.ok);
const errorRatePct = ((failed.rate || 0) * 100).toFixed(2);
const overallPassed = contract ? allThresholdsPassed && (contract.failed || 0) === 0 : allThresholdsPassed;

// Extract endpoint-level performance metrics
const endpointsList = [];
const prefix = "http_req_duration{endpoint:";
for (const [key, val] of Object.entries(k6.metrics || {})) {
  if (key.startsWith(prefix)) {
    const opId = key.slice(prefix.length, -1);
    const v = val.values ? { ...val, ...val.values } : val;
    endpointsList.push({
      opId,
      avg: v.avg || 0,
      p90: v["p(90)"] || 0,
      p95: v["p(95)"] || 0,
      p99: v["p(99)"] || 0,
      min: v.min || 0,
      max: v.max || 0,
    });
  }
}

// If endpointsList is empty, generate single summary entry
if (endpointsList.length === 0) {
  endpointsList.push({
    opId: "All Aggregated Endpoints",
    avg: dur.avg || 0,
    p90: dur["p(90)"] || 0,
    p95: dur["p(95)"] || 0,
    p99: dur["p(99)"] || 0,
    min: dur.min || 0,
    max: dur.max || 0,
  });
}

const executionDate = new Date().toUTCString();

// Build HTML template
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Executive Performance Report — ${config.run?.buildLabel || "Build"}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root {
      --bg: #0b0f19;
      --surface: #131b2e;
      --surface-border: #1e293b;
      --surface-hover: #1e293b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --primary-gradient: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
      --accent: #8b5cf6;
      --success: #10b981;
      --success-bg: rgba(16, 185, 129, 0.12);
      --danger: #ef4444;
      --danger-bg: rgba(239, 68, 68, 0.12);
      --warning: #f59e0b;
      --font-main: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font-main);
      line-height: 1.6;
      padding: 32px 24px 64px;
      max-width: 1280px;
      margin: 0 auto;
    }

    /* Header & Navigation Bar */
    .top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--surface-border);
      margin-bottom: 32px;
    }

    .brand-title {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.02em;
      background: linear-gradient(90deg, #60a5fa, #a78bfa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .brand-subtitle {
      font-size: 13px;
      color: var(--text-muted);
      font-weight: 500;
    }

    .btn-group {
      display: flex;
      gap: 12px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      transition: all 0.2s ease;
      border: 1px solid var(--surface-border);
      background: var(--surface);
      color: var(--text);
    }

    .btn:hover {
      background: var(--surface-hover);
      border-color: #334155;
    }

    .btn-primary {
      background: var(--primary-gradient);
      border: none;
      color: white;
      box-shadow: 0 4px 14px rgba(59, 130, 246, 0.3);
    }
    .btn-primary:hover {
      opacity: 0.95;
      transform: translateY(-1px);
    }

    /* Executive Summary Hero */
    .hero-banner {
      background: var(--surface);
      border: 1px solid var(--surface-border);
      border-radius: 16px;
      padding: 28px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 24px;
      margin-bottom: 28px;
      position: relative;
      overflow: hidden;
    }

    .hero-banner::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 4px;
      height: 100%;
      background: ${overallPassed ? "var(--success)" : "var(--danger)"};
    }

    .hero-info h1 {
      font-size: 26px;
      font-weight: 700;
      margin-bottom: 6px;
    }

    .meta-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 8px;
    }

    .meta-tag strong {
      color: var(--text);
    }

    .status-badge {
      padding: 10px 24px;
      border-radius: 12px;
      font-weight: 800;
      font-size: 18px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      display: flex;
      align-items: center;
      gap: 10px;
      background: ${overallPassed ? "var(--success-bg)" : "var(--danger-bg)"};
      color: ${overallPassed ? "var(--success)" : "var(--danger)"};
      border: 1px solid ${overallPassed ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"};
    }

    /* KPI Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }

    .kpi-card {
      background: var(--surface);
      border: 1px solid var(--surface-border);
      border-radius: 12px;
      padding: 20px;
      position: relative;
    }

    .kpi-label {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-muted);
      margin-bottom: 8px;
    }

    .kpi-value {
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -0.02em;
    }

    .kpi-hint {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    /* Section Styles */
    .section-title {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .section-title span {
      background: var(--surface);
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 12px;
      color: var(--text-muted);
      font-weight: 600;
    }

    /* Chart Container */
    .chart-panel {
      background: var(--surface);
      border: 1px solid var(--surface-border);
      border-radius: 14px;
      padding: 24px;
      margin-bottom: 32px;
    }

    /* Table Styles */
    .table-container {
      background: var(--surface);
      border: 1px solid var(--surface-border);
      border-radius: 14px;
      overflow: hidden;
      margin-bottom: 32px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 13.5px;
    }

    th {
      background: #0f172a;
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.05em;
      padding: 14px 18px;
      border-bottom: 1px solid var(--surface-border);
    }

    td {
      padding: 14px 18px;
      border-bottom: 1px solid var(--surface-border);
      color: var(--text);
    }

    tr:last-child td {
      border-bottom: none;
    }

    tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }

    .code-tag {
      font-family: var(--font-mono);
      font-size: 12px;
      background: #0f172a;
      padding: 3px 8px;
      border-radius: 6px;
      border: 1px solid #1e293b;
    }

    .pill {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .pill-pass {
      background: var(--success-bg);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .pill-fail {
      background: var(--danger-bg);
      color: var(--danger);
      border: 1px solid rgba(239, 68, 68, 0.3);
    }

    /* Contract Testing Section */
    .contract-box {
      background: var(--surface);
      border: 1px solid var(--surface-border);
      border-radius: 14px;
      padding: 24px;
      margin-bottom: 32px;
    }

    .footer {
      text-align: center;
      color: var(--text-muted);
      font-size: 12px;
      margin-top: 48px;
      border-top: 1px solid var(--surface-border);
      padding-top: 24px;
    }

    @media (max-width: 768px) {
      .hero-banner { flex-direction: column; align-items: flex-start; }
      .top-bar { flex-direction: column; align-items: flex-start; }
    }
  </style>
</head>
<body>

  <!-- Top Navigation & Actions -->
  <div class="top-bar">
    <div>
      <div class="brand-title">Executive Performance Report</div>
      <div class="brand-subtitle">Automated OpenAPI Performance Pipeline & SLA Gatekeeper</div>
    </div>
    <div class="btn-group">
      <a href="allure-report/index.html" target="_blank" class="btn btn-primary">
        <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
        Open Allure Deep-Dive Report
      </a>
      <a href="k6-summary.json" target="_blank" class="btn">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
        Export JSON
      </a>
      <button onclick="window.print()" class="btn">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2m-4 0h-8v4h8v-4z"/></svg>
        Print / PDF
      </button>
    </div>
  </div>

  <!-- Hero Summary Banner -->
  <div class="hero-banner">
    <div class="hero-info">
      <h1>${config.run?.projectName || "Spring Boot Microservice Load Benchmark"}</h1>
      <div class="meta-tags">
        <span class="meta-tag">Build: <strong>${config.run?.buildLabel || "v1.0"}</strong></span>
        <span class="meta-tag">Environment: <strong>${config.run?.environment || "staging"}</strong></span>
        <span class="meta-tag">Base URL: <strong>${config.baseUrl || "http://localhost:8080"}</strong></span>
        <span class="meta-tag">Run Time: <strong>${executionDate}</strong></span>
      </div>
    </div>
    <div>
      <div class="status-badge">
        <span>${overallPassed ? "●" : "▲"}</span>
        <span>${overallPassed ? "PASSED SLA" : "FAILED SLA"}</span>
      </div>
    </div>
  </div>

  <!-- Key Executive Metrics Grid -->
  <div class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-label">P95 Latency</div>
      <div class="kpi-value" style="color: ${(dur["p(95)"] || 0) <= (config.thresholds?.p95Ms || 500) ? "var(--success)" : "var(--danger)"};">
        ${fmt(dur["p(95)"])} ms
      </div>
      <div class="kpi-hint">Target SLA: &lt; ${config.thresholds?.p95Ms || 500} ms</div>
    </div>

    <div class="kpi-card">
      <div class="kpi-label">P99 Latency</div>
      <div class="kpi-value" style="color: ${(dur["p(99)"] || 0) <= (config.thresholds?.p99Ms || 1000) ? "var(--success)" : "var(--danger)"};">
        ${fmt(dur["p(99)"])} ms
      </div>
      <div class="kpi-hint">Target SLA: &lt; ${config.thresholds?.p99Ms || 1000} ms</div>
    </div>

    <div class="kpi-card">
      <div class="kpi-label">Throughput</div>
      <div class="kpi-value" style="color: var(--primary);">
        ${fmt(reqs.rate, 1)} <span style="font-size: 14px; font-weight: 600;">req/s</span>
      </div>
      <div class="kpi-hint">${fmt(reqs.count, 0)} total requests</div>
    </div>

    <div class="kpi-card">
      <div class="kpi-label">Error Rate</div>
      <div class="kpi-value" style="color: ${Number(errorRatePct) <= ((config.thresholds?.maxErrorRate || 0.01) * 100) ? "var(--success)" : "var(--danger)"};">
        ${errorRatePct}%
      </div>
      <div class="kpi-hint">Limit: &le; ${((config.thresholds?.maxErrorRate || 0.01) * 100).toFixed(1)}%</div>
    </div>

    <div class="kpi-card">
      <div class="kpi-label">Peak Concurrency</div>
      <div class="kpi-value" style="color: var(--accent);">
        ${vusMax.value ?? "—"} <span style="font-size: 14px; font-weight: 600;">VUs</span>
      </div>
      <div class="kpi-hint">Concurrent simulated users</div>
    </div>
  </div>

  <!-- Interactive Latency Percentile Chart -->
  <div class="section-title">
    Latency Percentile Distribution (vs Target SLA)
    <span>Interactive Visual</span>
  </div>
  <div class="chart-panel">
    <canvas id="latencyChart" height="90"></canvas>
  </div>

  <!-- Endpoint Matrix Table -->
  <div class="section-title">
    Endpoint Performance Matrix
    <span>${endpointsList.length} Endpoints</span>
  </div>
  <div class="table-container">
    <table>
      <thead>
        <tr>
          <th>Operation / Endpoint</th>
          <th>Avg Latency</th>
          <th>P90</th>
          <th>P95</th>
          <th>P99</th>
          <th>Max</th>
          <th>SLA Status</th>
        </tr>
      </thead>
      <tbody>
        ${endpointsList
          .map((e) => {
            const passed = e.p95 <= (config.thresholds?.p95Ms || 500) * 1.5;
            return `<tr>
              <td><strong>${e.opId}</strong></td>
              <td>${fmt(e.avg)} ms</td>
              <td>${fmt(e.p90)} ms</td>
              <td style="font-weight: 700;">${fmt(e.p95)} ms</td>
              <td>${fmt(e.p99)} ms</td>
              <td>${fmt(e.max)} ms</td>
              <td>
                <span class="pill ${passed ? "pill-pass" : "pill-fail"}">
                  ${passed ? "MEETS SLA" : "BREACHED"}
                </span>
              </td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>
  </div>

  <!-- SLA Threshold Gatekeeper Table -->
  <div class="section-title">
    Configured SLA Gatekeeper Thresholds
    <span>${thresholdResults.length} Rules</span>
  </div>
  <div class="table-container">
    <table>
      <thead>
        <tr>
          <th>Metric Name</th>
          <th>Rule Expression</th>
          <th>Compliance Result</th>
        </tr>
      </thead>
      <tbody>
        ${thresholdResults
          .map(
            (t) => `<tr>
              <td><strong>${t.metricName}</strong></td>
              <td><span class="code-tag">${t.thresholdExpr}</span></td>
              <td>
                <span class="pill ${t.ok ? "pill-pass" : "pill-fail"}">
                  ${t.ok ? "PASS" : "FAIL"}
                </span>
              </td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table>
  </div>

  <!-- Contract Testing Section -->
  ${
    contract
      ? `
    <div class="section-title">
      OpenAPI Schema Contract Validation (Schemathesis)
      <span>${contract.total || 0} Contracts Checked</span>
    </div>
    <div class="contract-box">
      <div style="display: flex; gap: 24px; margin-bottom: 20px; flex-wrap: wrap;">
        <div>Total Tested: <strong>${contract.total || 0}</strong></div>
        <div style="color: var(--success);">Passed Contracts: <strong>${contract.passed || 0}</strong></div>
        <div style="color: ${contract.failed > 0 ? "var(--danger)" : "var(--success)"};">Violations: <strong>${contract.failed || 0}</strong></div>
      </div>
      ${
        contract.failures && contract.failures.length > 0
          ? `<div class="table-container">
              <table>
                <thead>
                  <tr><th>Endpoint</th><th>Schema Violation Reason</th></tr>
                </thead>
                <tbody>
                  ${contract.failures
                    .map((f) => `<tr><td><code>${f.endpoint}</code></td><td style="color: var(--danger);">${f.reason}</td></tr>`)
                    .join("")}
                </tbody>
              </table>
            </div>`
          : `<p style="color: var(--success); font-weight: 600;">✓ 100% of live HTTP responses conformed strictly to the OpenAPI specification.</p>`
      }
    </div>`
      : ""
  }

  <div class="footer">
    Generated automatically by <strong>k6 OpenAPI Performance Pipeline</strong> with Allure 2 Report Integration • ${executionDate}
  </div>

  <script>
    // Latency Percentile Chart Rendering
    const ctx = document.getElementById('latencyChart').getContext('2d');
    const labels = ${JSON.stringify(endpointsList.map((e) => e.opId))};
    const avgData = ${JSON.stringify(endpointsList.map((e) => Number(e.avg.toFixed(1))))};
    const p95Data = ${JSON.stringify(endpointsList.map((e) => Number(e.p95.toFixed(1))))};
    const p99Data = ${JSON.stringify(endpointsList.map((e) => Number(e.p99.toFixed(1))))};
    const targetSla = ${config.thresholds?.p95Ms || 500};

    new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Avg Latency (ms)',
            data: avgData,
            backgroundColor: 'rgba(59, 130, 246, 0.65)',
            borderColor: '#3b82f6',
            borderWidth: 1,
            borderRadius: 6
          },
          {
            label: 'P95 Latency (ms)',
            data: p95Data,
            backgroundColor: 'rgba(139, 92, 246, 0.75)',
            borderColor: '#8b5cf6',
            borderWidth: 1,
            borderRadius: 6
          },
          {
            label: 'P99 Latency (ms)',
            data: p99Data,
            backgroundColor: 'rgba(239, 68, 68, 0.75)',
            borderColor: '#ef4444',
            borderWidth: 1,
            borderRadius: 6
          }
        ]
      },
      options: {
        responsive: true,
        plugins: {
          legend: {
            labels: { color: '#94a3b8', font: { family: 'Plus Jakarta Sans', size: 12 } }
          },
          tooltip: {
            callbacks: {
              afterBody: () => 'Target P95 SLA: ' + targetSla + ' ms'
            }
          }
        },
        scales: {
          x: {
            grid: { color: '#1e293b' },
            ticks: { color: '#94a3b8', font: { family: 'Plus Jakarta Sans', size: 11 } }
          },
          y: {
            grid: { color: '#1e293b' },
            ticks: { color: '#94a3b8', callback: (val) => val + ' ms' },
            title: { display: true, text: 'Response Time (ms)', color: '#94a3b8' }
          }
        }
      }
    });
  </script>
</body>
</html>
`;

fs.writeFileSync(outPath, html, "utf8");
console.log(`[generate-management-report] Executive HTML report written -> ${outPath}`);
console.log(`[generate-management-report] Status: ${overallPassed ? "PASSED" : "FAILED"}`);
