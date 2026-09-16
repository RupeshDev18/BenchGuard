/**
 * server.js
 *
 * Express Web Server & Real-time WebSocket API
 * Powers the Management Dashboard, OpenAPI Studio, and Test Runner.
 */

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const multer = require("multer");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const CONFIG_FILE = path.join(ROOT_DIR, "config.json");
const REPORT_OUTPUT_DIR = path.join(ROOT_DIR, "report-output");

app.use(cors());
app.use(express.json());

// Serve static assets for the UI
app.use(express.static(path.join(ROOT_DIR, "src/public")));

// Serve generated reports directly
app.use("/reports", express.static(REPORT_OUTPUT_DIR));

// Configure upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ROOT_DIR),
  filename: (req, file, cb) => cb(null, "uploaded-openapi.json"),
});
const upload = multer({ storage });

// State tracking
let activeProcess = null;
let pipelineRunning = false;
let mockServerProcess = null;
let mockServerRunning = false;

// Broadcast helper for WebSockets
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

// Get current configuration
app.get("/api/config", (req, res) => {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return res.status(404).json({ error: "config.json not found" });
    }
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update configuration
app.post("/api/config", (req, res) => {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(req.body, null, 2), "utf8");
    res.json({ success: true, message: "Configuration saved successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper for default schema sample in UI
function sampleFromSchema(schema, rootSpec, depth = 0, keyName = "") {
  if (!schema || depth > 5) return "sample";
  if (schema.$ref) {
    const parts = schema.$ref.replace(/^#\//, "").split("/");
    let node = rootSpec;
    for (const p of parts) { if (node && typeof node === "object") node = node[p]; }
    if (!node || node === schema) return "sample_ref";
    return sampleFromSchema(node, rootSpec, depth + 1, keyName);
  }
  const lKey = keyName.toLowerCase();
  if (lKey.includes("email") || schema.format === "email") return "user_{{$vu}}_{{$timestamp}}@example.com";
  if (lKey === "sku" || lKey.endsWith("sku")) return "SKU-{{$vu}}-{{$timestamp}}";
  if (lKey === "username" || lKey === "user_name") return "user_{{$vu}}_{{$timestamp}}";
  if (lKey === "customerid" || lKey === "customer_id") return "CUST-{{$vu}}";
  if (lKey === "uuid" || schema.format === "uuid") return "{{$randomUUID}}";
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  if (schema.allOf) {
    let merged = {};
    for (const sub of schema.allOf) {
      const v = sampleFromSchema(sub, rootSpec, depth + 1, keyName);
      if (typeof v === "object" && v !== null) Object.assign(merged, v);
    }
    return merged;
  }

  const type = schema.type || (schema.properties ? "object" : "string");
  if (type === "object") {
    const obj = {};
    for (const [k, p] of Object.entries(schema.properties || {})) {
      obj[k] = sampleFromSchema(p, rootSpec, depth + 1, k);
    }
    return obj;
  }
  if (type === "array") return [sampleFromSchema(schema.items || {}, rootSpec, depth + 1, keyName)];
  if (type === "integer") return 101;
  if (type === "number") return 49.99;
  if (type === "boolean") return true;
  return "sample_value";
}

// Comprehensive parser and diagnostic validator
function validateAndParseSpec(rawInput, epConfigs = {}) {
  let spec = null;
  const errors = [];
  const warnings = [];

  if (typeof rawInput === "string") {
    try {
      spec = JSON.parse(rawInput);
    } catch (e) {
      return {
        valid: false,
        format: "Invalid JSON",
        title: "Unknown Specification",
        version: "0.0.0",
        errors: [`JSON Syntax Error: ${e.message}. Ensure the uploaded or pasted content is well-formed JSON.`],
        warnings: [],
        endpointsCount: 0,
        methodCounts: {},
        endpoints: [],
      };
    }
  } else {
    spec = rawInput;
  }

  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return {
      valid: false,
      format: "Invalid JSON Structure",
      title: "Unknown Specification",
      version: "0.0.0",
      errors: ["Specification root must be a valid JSON object, not an array or scalar."],
      warnings: [],
      endpointsCount: 0,
      methodCounts: {},
      endpoints: [],
    };
  }

  // Detect format
  let format = "Unknown";
  if (spec.openapi) {
    format = `OpenAPI ${spec.openapi}`;
  } else if (spec.swagger) {
    format = `Swagger ${spec.swagger}`;
  } else {
    warnings.push("Missing 'openapi' or 'swagger' version tag at root. Assuming OpenAPI/Swagger compatible paths.");
  }

  // Check paths
  if (!spec.paths || typeof spec.paths !== "object") {
    const rootKeys = Object.keys(spec).join(", ") || "none";
    errors.push(`Missing 'paths' object. An OpenAPI/Swagger specification must define a 'paths' dictionary of API routes. Root keys found: [${rootKeys}]`);
    return {
      valid: false,
      format,
      title: spec.info?.title || "Unknown API Specification",
      version: spec.info?.version || "1.0.0",
      description: spec.info?.description || "",
      errors,
      warnings,
      endpointsCount: 0,
      methodCounts: {},
      endpoints: [],
    };
  }

  const endpoints = [];
  const methods = ["get", "post", "put", "patch", "delete", "options", "head"];
  const methodCounts = {};

  for (const [route, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;

    for (const m of methods) {
      const op = pathItem[m];
      if (!op) continue;

      const opId = op.operationId || `${m}_${route.replace(/[^a-zA-Z0-9]/g, "_")}`;
      const configured = epConfigs[opId] || {};
      const methodUpper = m.toUpperCase();
      methodCounts[methodUpper] = (methodCounts[methodUpper] || 0) + 1;

      // Extract parameters
      const allParams = [...(pathItem.parameters || []), ...(op.parameters || [])];

      // Request Body Schema Resolution (OpenAPI 3.x or Swagger 2.0)
      let schemaObj = null;
      let hasBody = false;

      if (op.requestBody && op.requestBody.content) {
        hasBody = true;
        const jsonContent = op.requestBody.content["application/json"] ||
                            op.requestBody.content["application/*+json"] ||
                            Object.values(op.requestBody.content)[0];
        if (jsonContent && jsonContent.schema) {
          schemaObj = jsonContent.schema;
        } else {
          warnings.push(`Endpoint [${methodUpper} ${route}] has requestBody without an application/json schema.`);
        }
      } else {
        const bodyParam = allParams.find((p) => p && p.in === "body");
        if (bodyParam) {
          hasBody = true;
          schemaObj = bodyParam.schema;
        } else if (["POST", "PUT", "PATCH"].includes(methodUpper)) {
          warnings.push(`Endpoint [${methodUpper} ${route}] is a mutating method but defines no requestBody or in:body parameter.`);
        }
      }

      let defaultBody = null;
      if (schemaObj) {
        try {
          defaultBody = sampleFromSchema(schemaObj, spec);
        } catch (sampleErr) {
          warnings.push(`Failed sampling schema for [${methodUpper} ${route}]: ${sampleErr.message}`);
          defaultBody = { note: "Sample generation fallback", sample: true };
        }
      } else if (hasBody) {
        defaultBody = { data: "sample_payload" };
      }

      // Check responses / expected status codes
      let expectedStatus = configured.expectedStatus;
      if (!expectedStatus || !expectedStatus.length) {
        const responseCodes = op.responses ? Object.keys(op.responses).filter(c => /^[1-5]\d\d$/.test(c)).map(Number) : [];
        const successCodes = responseCodes.filter(c => c >= 200 && c < 300);
        if (successCodes.length > 0) {
          expectedStatus = successCodes;
        } else {
          expectedStatus = methodUpper === "POST" ? [200, 201] : [200, 201, 204];
        }
      }

      endpoints.push({
        opId,
        method: methodUpper,
        route,
        summary: op.summary || op.description || `${methodUpper} ${route}`,
        tag: (op.tags && op.tags[0]) || "General",
        parameters: allParams,
        hasBody,
        defaultBody,
        customBody: configured.body !== undefined ? configured.body : null,
        expectedStatus,
      });
    }
  }

  if (endpoints.length === 0) {
    errors.push("No valid HTTP operations (GET, POST, PUT, DELETE, etc.) found in the 'paths' object.");
  }

  const valid = errors.length === 0;

  return {
    valid,
    format,
    title: spec.info?.title || "API Specification",
    version: spec.info?.version || "1.0.0",
    description: spec.info?.description || "",
    endpointsCount: endpoints.length,
    methodCounts,
    warnings,
    errors,
    endpoints,
  };
}

// Parse OpenAPI endpoints from file with schema payloads & configs
app.get("/api/spec/endpoints", (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const openapiPath = path.resolve(ROOT_DIR, config.openapiPath || "sample-openapi.json");
    if (!fs.existsSync(openapiPath)) {
      return res.status(404).json({ 
        valid: false, 
        error: `OpenAPI file not found at ${openapiPath}`,
        errors: [`OpenAPI file not found at ${openapiPath}`],
        warnings: [],
        endpoints: []
      });
    }
    const rawContent = fs.readFileSync(openapiPath, "utf8");
    const result = validateAndParseSpec(rawContent, config.endpointConfigs || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message, errors: [err.message], endpoints: [] });
  }
});

// Upload OpenAPI file with instant validation
app.post("/api/spec/upload", upload.single("spec"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ valid: false, error: "No file uploaded", errors: ["No file uploaded"] });
    const filePath = req.file.path;
    const rawContent = fs.readFileSync(filePath, "utf8");
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const diagnostics = validateAndParseSpec(rawContent, {});

    if (!diagnostics.valid) {
      return res.status(400).json({
        success: false,
        valid: false,
        filename: req.file.originalname,
        error: diagnostics.errors.join("; "),
        diagnostics,
      });
    }

    config.openapiPath = "uploaded-openapi.json";
    config.endpoints = { include: ["all"], exclude: [] };
    config.endpointConfigs = {};
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
    res.json({
      success: true,
      valid: true,
      filename: req.file.originalname,
      diagnostics,
      endpoints: diagnostics.endpoints,
    });
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message, errors: [err.message] });
  }
});

// Fetch OpenAPI from live URL with instant validation
app.post("/api/spec/fetch-url", async (req, res) => {
  const { url: targetUrl } = req.body;
  if (!targetUrl) return res.status(400).json({ valid: false, error: "URL is required" });

  try {
    const response = await fetch(targetUrl);
    if (!response.ok) throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
    const text = await response.text();
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const diagnostics = validateAndParseSpec(text, {});

    if (!diagnostics.valid) {
      return res.status(400).json({
        success: false,
        valid: false,
        error: diagnostics.errors.join("; "),
        diagnostics,
      });
    }

    const dest = path.join(ROOT_DIR, "fetched-openapi.json");
    fs.writeFileSync(dest, text, "utf8");

    config.openapiPath = "fetched-openapi.json";
    config.endpoints = { include: ["all"], exclude: [] };
    config.endpointConfigs = {};
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");

    res.json({
      success: true,
      valid: true,
      message: `Successfully fetched and validated specification from ${targetUrl}`,
      diagnostics,
      endpoints: diagnostics.endpoints,
    });
  } catch (err) {
    res.status(500).json({ valid: false, error: `Failed to fetch OpenAPI: ${err.message}`, errors: [err.message] });
  }
});

// Direct raw JSON upload/paste with instant validation
app.post("/api/spec/raw", (req, res) => {
  const { rawJson } = req.body;
  if (!rawJson) return res.status(400).json({ valid: false, error: "JSON content is required" });

  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const diagnostics = validateAndParseSpec(rawJson, {});

    if (!diagnostics.valid) {
      return res.status(400).json({
        success: false,
        valid: false,
        error: diagnostics.errors.join("; "),
        diagnostics,
      });
    }

    const dest = path.join(ROOT_DIR, "raw-openapi.json");
    fs.writeFileSync(dest, typeof rawJson === "string" ? rawJson : JSON.stringify(rawJson, null, 2), "utf8");

    config.openapiPath = "raw-openapi.json";
    config.endpoints = { include: ["all"], exclude: [] };
    config.endpointConfigs = {};
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");

    res.json({
      success: true,
      valid: true,
      message: "Raw JSON specification parsed and validated successfully",
      diagnostics,
      endpoints: diagnostics.endpoints,
    });
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message, errors: [err.message] });
  }
});

// Switch to Sample Spec
app.post("/api/spec/sample", (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    config.openapiPath = "sample-openapi.json";
    config.endpoints = { include: ["all"], exclude: [] };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");

    const rawContent = fs.readFileSync(path.join(ROOT_DIR, "sample-openapi.json"), "utf8");
    const diagnostics = validateAndParseSpec(rawContent, config.endpointConfigs || {});
    res.json({
      success: true,
      valid: true,
      message: "Switched to Sample E-Commerce specification",
      diagnostics,
      endpoints: diagnostics.endpoints,
    });
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message, errors: [err.message] });
  }
});

// -------------------------------------------------------------
// Dataset Upload & Management (CSV / JSON)
// -------------------------------------------------------------
const dataDir = path.join(ROOT_DIR, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const datasetStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, dataDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `test-dataset${ext}`);
  },
});
const datasetUpload = multer({ storage: datasetStorage });

app.post("/api/dataset/upload", datasetUpload.single("dataset"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();

    let rows = [];
    let columns = [];
    let totalCount = 0;

    if (ext === ".csv") {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length > 0) {
        columns = lines[0].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
        totalCount = lines.length - 1;
        rows = lines.slice(1, 6).map((l) => {
          const parts = l.split(",");
          const row = {};
          columns.forEach((col, idx) => {
            row[col] = (parts[idx] || "").trim().replace(/^"|"$/g, "");
          });
          return row;
        });
      }
    } else {
      const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (Array.isArray(content)) {
        totalCount = content.length;
        rows = content.slice(0, 5);
        columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      }
    }

    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    config.datasetPath = path.relative(ROOT_DIR, filePath).replace(/\\/g, "/");
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");

    res.json({
      success: true,
      filename: req.file.originalname,
      datasetPath: config.datasetPath,
      columns,
      preview: rows,
      totalCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/dataset", (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const dPath = config.datasetPath;
    if (!dPath || !fs.existsSync(path.resolve(ROOT_DIR, dPath))) {
      return res.json({ hasDataset: false });
    }
    const fullPath = path.resolve(ROOT_DIR, dPath);
    const ext = path.extname(fullPath).toLowerCase();
    let rows = [];
    let columns = [];
    let totalCount = 0;

    if (ext === ".csv") {
      const content = fs.readFileSync(fullPath, "utf8");
      const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length > 0) {
        columns = lines[0].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
        totalCount = lines.length - 1;
        rows = lines.slice(1, 6).map((l) => {
          const parts = l.split(",");
          const row = {};
          columns.forEach((col, idx) => {
            row[col] = (parts[idx] || "").trim().replace(/^"|"$/g, "");
          });
          return row;
        });
      }
    } else {
      const content = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      if (Array.isArray(content)) {
        totalCount = content.length;
        rows = content.slice(0, 5);
        columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      }
    }

    res.json({
      hasDataset: true,
      filename: path.basename(dPath),
      datasetPath: dPath,
      columns,
      preview: rows,
      totalCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/dataset", (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    if (config.datasetPath) {
      const fullPath = path.resolve(ROOT_DIR, config.datasetPath);
      // Only delete temporary uploaded file, do NOT crash or delete sample-users.csv
      if (config.datasetPath.includes("test-dataset") && fs.existsSync(fullPath)) {
        try { fs.unlinkSync(fullPath); } catch (e) { /* ignore locked file */ }
      }
      delete config.datasetPath;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
    }
    res.json({ success: true, message: "Dataset removed successfully from configuration" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle Mock Spring Boot Server
app.post("/api/mock/toggle", (req, res) => {
  if (mockServerRunning) {
    if (mockServerProcess) {
      mockServerProcess.kill();
      mockServerProcess = null;
    }
    mockServerRunning = false;
    broadcast("mock_status", { running: false });
    return res.json({ running: false, message: "Mock server stopped" });
  } else {
    mockServerProcess = spawn("node", [path.join(ROOT_DIR, "src/mock-server/mock-api.js")], {
      stdio: "pipe",
      shell: true,
    });
    mockServerRunning = true;
    mockServerProcess.on("close", () => {
      mockServerRunning = false;
      broadcast("mock_status", { running: false });
    });
    broadcast("mock_status", { running: true, port: 8080 });
    return res.json({ running: true, port: 8080, message: "Mock server started on http://localhost:8080" });
  }
});

app.get("/api/mock/status", (req, res) => {
  res.json({ running: mockServerRunning, port: 8080 });
});

// Trigger test execution
app.post("/api/pipeline/start", (req, res) => {
  if (pipelineRunning) {
    return res.status(409).json({ error: "Pipeline is already running" });
  }

  // Update config if body provided
  if (req.body && Object.keys(req.body).length > 0) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(req.body, null, 2), "utf8");
  }

  pipelineRunning = true;
  broadcast("pipeline_started", { startTime: new Date().toISOString() });

  activeProcess = spawn("node", ["run-pipeline.js", "--config", "config.json"], {
    cwd: ROOT_DIR,
    shell: true,
  });

  activeProcess.stdout.on("data", (data) => {
    const text = data.toString();
    broadcast("log", { text, stream: "stdout" });
  });

  activeProcess.stderr.on("data", (data) => {
    const text = data.toString();
    broadcast("log", { text, stream: "stderr" });
  });

  activeProcess.on("close", (code) => {
    pipelineRunning = false;
    activeProcess = null;
    broadcast("pipeline_finished", { exitCode: code, finishedAt: new Date().toISOString() });

    // Save run to history index
    saveRunHistory(code);
  });

  res.json({ success: true, message: "Load test pipeline started" });
});

// Abort test execution
app.post("/api/pipeline/stop", (req, res) => {
  if (!pipelineRunning || !activeProcess) {
    return res.status(400).json({ error: "No active pipeline to stop" });
  }
  try {
    activeProcess.kill();
    pipelineRunning = false;
    activeProcess = null;
    broadcast("pipeline_aborted", { message: "Pipeline aborted by user" });
    res.json({ success: true, message: "Pipeline terminated" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get pipeline status
app.get("/api/pipeline/status", (req, res) => {
  res.json({ running: pipelineRunning });
});

// History of runs
const HISTORY_FILE = path.join(REPORT_OUTPUT_DIR, "runs-history.json");

function saveRunHistory(exitCode) {
  try {
    const summaryFile = path.join(REPORT_OUTPUT_DIR, "k6-summary.json");
    if (!fs.existsSync(summaryFile)) return;

    const summary = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
    const getM = (name) => {
      const m = summary.metrics?.[name];
      if (!m) return {};
      return m.values ? { ...m, ...m.values } : m;
    };

    const dur = getM("http_req_duration");
    const reqs = getM("http_reqs");
    const failed = getM("http_req_failed");
    const vus = getM("vus_max");
    const config = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) : {};

    const runRecord = {
      id: Date.now(),
      date: new Date().toISOString(),
      buildLabel: config.run?.buildLabel || "build",
      environment: config.run?.environment || "staging",
      exitCode,
      passed: exitCode === 0,
      p95: dur["p(95)"] || 0,
      p99: dur["p(99)"] || 0,
      avg: dur.avg || 0,
      throughput: reqs.rate || 0,
      totalRequests: reqs.count || 0,
      errorRate: ((failed.rate || 0) * 100).toFixed(2),
      peakVus: vus.value || 0,
    };

    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    }
    history.unshift(runRecord);
    // Keep last 30 runs
    if (history.length > 30) history = history.slice(0, 30);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf8");
  } catch (err) {
    console.error("[server] Failed to record run history:", err.message);
  }
}

app.get("/api/runs", (req, res) => {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
      res.json(history);
    } else {
      res.json([]);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check if reports exist
app.get("/api/reports/status", (req, res) => {
  const managementReportExists = fs.existsSync(path.join(REPORT_OUTPUT_DIR, "report.html"));
  const allureReportExists = fs.existsSync(path.join(REPORT_OUTPUT_DIR, "allure-report/index.html"));
  const k6SummaryExists = fs.existsSync(path.join(REPORT_OUTPUT_DIR, "k6-summary.json"));

  res.json({
    hasManagementReport: managementReportExists,
    hasAllureReport: allureReportExists,
    hasK6Summary: k6SummaryExists,
    managementReportUrl: "/reports/report.html",
    allureReportUrl: "/reports/allure-report/index.html",
    k6SummaryUrl: "/reports/k6-summary.json",
  });
});

// Fallback to index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "src/public/index.html"));
});

// WebSocket Connection Handler
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "init", data: { running: pipelineRunning, mockRunning: mockServerRunning } }));
});

// Start Server
server.listen(PORT, () => {
  console.log(`\n==================================================================`);
  console.log(` 🌐 PERFORMANCE DASHBOARD & STUDIO READY`);
  console.log(` URL: http://localhost:${PORT}`);
  console.log(`==================================================================\n`);
});
