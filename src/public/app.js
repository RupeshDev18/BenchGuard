/**
 * app.js
 *
 * Front-end controller for the k6 & Allure Performance Studio
 * Features:
 *  - Theme Engine: Clean Light Mode (default) with Dark Mode toggle
 *  - Toast Notifications: Modern non-blocking feedback across all user actions
 *  - Drag & Drop / Direct Spec Upload with immediate endpoint replacement
 *  - Instant Spec Diagnostic Validator (OpenAPI 3.x & Swagger 2.0)
 *  - Endpoint & Scenario Configurator with Dynamic Tokens & Datasets
 *  - Safe Dataset Management & Removal
 *  - Live Streaming Console via WebSocket & Report Hub
 */

let appConfig = null;
let apiEndpoints = [];
let ws = null;
let runTimerInterval = null;
let runStartTime = null;
let currentEditingEndpoint = null;
let activeDataset = null;
let mockServerRunning = false;
let selectedSpecFile = null;

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initTabs();
  initWebSocket();
  loadConfigAndSpec();
  initDemoSandbox();
  initSpecIngestionControls();
  initEndpointsControls();
  initStagesControls();
  initDatasetControls();
  initModalControls();
  initActions();
  loadRunHistory();
  initAnalytics();
  checkDatabaseStatus();
});

// -------------------------------------------------------------
// 1. Toast Notification System
// -------------------------------------------------------------
function showToast(message, type = "info", title = "") {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;

  let icon = "ℹ️";
  let defaultTitle = "Notification";
  if (type === "success") { icon = "✓"; defaultTitle = "Success"; }
  else if (type === "error") { icon = "✕"; defaultTitle = "Error"; }
  else if (type === "warning") { icon = "⚠️"; defaultTitle = "Warning"; }

  toast.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <div class="toast-content">
      <div class="toast-title">${title || defaultTitle}</div>
      <div class="toast-message">${escapeHtml(message)}</div>
    </div>
    <button class="toast-close" type="button">✕</button>
  `;

  toast.querySelector(".toast-close").addEventListener("click", () => toast.remove());
  container.appendChild(toast);

  setTimeout(() => {
    if (toast.parentElement) {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(50px)";
      setTimeout(() => toast.remove(), 200);
    }
  }, 4000);
}

// -------------------------------------------------------------
// 2. Theme Engine (Light Mode Default with Dark Toggle)
// -------------------------------------------------------------
function initTheme() {
  const savedTheme = localStorage.getItem("k6_theme") || "light"; // Default Light Mode!
  applyTheme(savedTheme);

  const toggleBtn = document.getElementById("themeToggleBtn");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const current = document.documentElement.classList.contains("dark") ? "dark" : "light";
      const next = current === "dark" ? "light" : "dark";
      applyTheme(next);
      localStorage.setItem("k6_theme", next);
      showToast(`Switched to ${next.toUpperCase()} theme`, "info", "Theme");
    });
  }
}

function applyTheme(theme) {
  const toggleBtn = document.getElementById("themeToggleBtn");
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
    if (toggleBtn) toggleBtn.textContent = "🌙";
  } else {
    document.documentElement.classList.remove("dark");
    if (toggleBtn) toggleBtn.textContent = "☀️";
  }
  drawLoadCurve();
}

// -------------------------------------------------------------
// 3. Navigation & Tab Switching
// -------------------------------------------------------------
function initTabs() {
  const tabs = document.querySelectorAll(".tab-btn");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetId = `tab-${tab.dataset.tab}`;
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
      const targetContent = document.getElementById(targetId);
      if (targetContent) targetContent.classList.add("active");

      if (tab.dataset.tab === "history") loadRunHistory();
      if (tab.dataset.tab === "analytics") loadAnalytics();
      if (tab.dataset.tab === "managementReport") refreshIframes();
      if (tab.dataset.tab === "allureReport") refreshIframes();
      if (tab.dataset.tab === "studio") drawLoadCurve();
    });
  });

  const goToRealStudioBtn = document.getElementById("goToRealStudioBtn");
  if (goToRealStudioBtn) {
    goToRealStudioBtn.addEventListener("click", () => switchTab("studio"));
  }
}

function switchTab(tabName) {
  const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
  if (btn) btn.click();
}

function refreshIframes() {
  const mgmtIframe = document.getElementById("managementReportIframe");
  const allureIframe = document.getElementById("allureReportIframe");
  if (mgmtIframe) mgmtIframe.src = "/reports/report.html?t=" + Date.now();
  if (allureIframe) allureIframe.src = "/reports/allure-report/index.html?t=" + Date.now();
}

// -------------------------------------------------------------
// 4. Initial Data Loading & Population
// -------------------------------------------------------------
async function loadConfigAndSpec() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error("Could not load config");
    appConfig = await res.json();
    if (!appConfig.endpointConfigs) appConfig.endpointConfigs = {};

    populateForm(appConfig);
    await loadSpecEndpoints();
    await loadDatasetInfo();
    await checkMockStatus();
  } catch (err) {
    console.error("Failed loading initial data:", err);
    showToast("Failed loading configuration: " + err.message, "error");
  }
}

function populateForm(cfg) {
  document.getElementById("baseUrlInput").value = cfg.baseUrl || "http://localhost:8080";
  document.getElementById("buildLabelInput").value = cfg.run?.buildLabel || "release-1.0.0";
  document.getElementById("environmentInput").value = cfg.run?.environment || "staging";

  if (cfg.headers?.Authorization) {
    const token = cfg.headers.Authorization.replace(/^Bearer\s+/i, "");
    document.getElementById("authTokenInput").value = token;
  }

  const customH = { ...cfg.headers };
  delete customH["Authorization"];
  delete customH["Content-Type"];
  if (Object.keys(customH).length > 0) {
    document.getElementById("customHeadersInput").value = JSON.stringify(customH, null, 2);
  } else {
    document.getElementById("customHeadersInput").value = "";
  }

  // Thresholds
  document.getElementById("p95Threshold").value = cfg.thresholds?.p95Ms || 500;
  document.getElementById("p99Threshold").value = cfg.thresholds?.p99Ms || 1000;
  document.getElementById("maxErrorRate").value = ((cfg.thresholds?.maxErrorRate ?? 0.01) * 100).toFixed(1);

  // Contract testing
  document.getElementById("contractEnabledCheckbox").checked = !!cfg.contractTesting?.enabled;

  // Load profile
  const mode = cfg.load?.mode || "stages";
  setLoadMode(mode);

  if (mode === "stages" && Array.isArray(cfg.load?.stages)) {
    renderStagesRows(cfg.load.stages);
  } else {
    document.getElementById("flatVus").value = cfg.load?.vus || 20;
    document.getElementById("flatDuration").value = cfg.load?.duration || "30s";
  }

  drawLoadCurve();
}

// -------------------------------------------------------------
// 5. Demo Sandbox Controls
// -------------------------------------------------------------
function initDemoSandbox() {
  const toggleBtn = document.getElementById("demoToggleMockBtn");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", async () => {
      try {
        toggleBtn.disabled = true;
        const res = await fetch("/api/mock/toggle", { method: "POST" });
        const data = await res.json();
        updateMockServerUI(data.running);
        showToast(data.message, data.running ? "success" : "info", "Mock Server");
      } catch (e) {
        showToast("Failed to toggle mock server: " + e.message, "error");
      } finally {
        toggleBtn.disabled = false;
      }
    });
  }

  const runDemoBtn = document.getElementById("runDemoBenchmarkBtn");
  if (runDemoBtn) {
    runDemoBtn.addEventListener("click", async () => {
      // Ensure mock server is running
      if (!mockServerRunning) {
        try {
          await fetch("/api/mock/toggle", { method: "POST" });
          updateMockServerUI(true);
        } catch (e) {
          console.warn("Could not auto-start mock server:", e);
        }
      }

      // Configure preset demo benchmark
      const demoConfig = {
        ...appConfig,
        baseUrl: "http://localhost:8080",
        openapiPath: "sample-openapi.json",
        datasetPath: "data/sample-users.csv",
        run: {
          buildLabel: "demo-benchmark-v1",
          environment: "sandbox-mock",
        },
        load: {
          mode: "stages",
          stages: [
            { duration: "3s", target: 5 },
            { duration: "4s", target: 10 },
            { duration: "3s", target: 0 },
          ],
        },
        thresholds: {
          p95Ms: 500,
          p99Ms: 1000,
          maxErrorRate: 0.01,
        },
        contractTesting: {
          enabled: true,
          checks: ["all_status_codes", "all_schemas"],
        },
        endpoints: {
          include: ["all"],
          exclude: [],
        },
      };

      appConfig = demoConfig;
      populateForm(appConfig);
      await saveConfigToServer(demoConfig);
      await loadSpecEndpoints();

      showToast("Demo benchmark configured! Launching pipeline...", "info", "Sandbox");

      // Switch to live console and execute
      switchTab("console");
      startPerformanceTest();
    });
  }
}

async function checkMockStatus() {
  try {
    const res = await fetch("/api/mock/status");
    const data = await res.json();
    updateMockServerUI(data.running);
  } catch (err) {
    console.error("Failed to check mock status:", err);
  }
}

function updateMockServerUI(isRunning) {
  mockServerRunning = isRunning;
  const badge = document.getElementById("demoMockBadge");
  const toggleBtn = document.getElementById("demoToggleMockBtn");
  const title = document.getElementById("demoMockStatusTitle");

  if (isRunning) {
    badge.className = "badge badge-success";
    badge.textContent = "Running (Port 8080)";
    toggleBtn.className = "btn btn-danger btn-sm";
    toggleBtn.textContent = "Stop Mock Server";
    title.textContent = "Spring Boot Mock Running";
  } else {
    badge.className = "badge";
    badge.textContent = "Stopped";
    toggleBtn.className = "btn btn-secondary btn-sm";
    toggleBtn.textContent = "Start Mock Server";
    title.textContent = "Mock Server Stopped";
  }
}

// -------------------------------------------------------------
// 6. Spec Ingestion, Drag & Drop & Diagnostics
// -------------------------------------------------------------
function initSpecIngestionControls() {
  // Mode switcher pills
  document.querySelectorAll("[data-spec-mode]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll("[data-spec-mode]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const mode = btn.dataset.specMode;

      document.getElementById("specUploadContainer").classList.toggle("hidden", mode !== "upload");
      document.getElementById("specUrlContainer").classList.toggle("hidden", mode !== "url");
      document.getElementById("specRawContainer").classList.toggle("hidden", mode !== "raw");

      if (mode === "sample") {
        try {
          renderDiagnosticLoading("Switching to sample e-commerce specification...");
          const res = await fetch("/api/spec/sample", { method: "POST" });
          const data = await res.json();
          if (data.valid) {
            appConfig.openapiPath = "sample-openapi.json";
            apiEndpoints = data.endpoints || [];
            document.getElementById("endpointSearchInput").value = "";
            renderDiagnostics(data.diagnostics);
            renderEndpointsList();
            showToast("Loaded Sample E-Commerce Spec (7 endpoints)", "success", "Specification");
          }
        } catch (e) {
          showToast("Failed loading sample spec: " + e.message, "error");
        }
      }
    });
  });

  // Drag & Drop Zone
  const dropzone = document.getElementById("specDropzone");
  const fileInput = document.getElementById("specFileInput");
  const selectedFileBox = document.getElementById("specSelectedFileBox");
  const selectedFileName = document.getElementById("specSelectedFileName");
  const selectedFileSize = document.getElementById("specSelectedFileSize");
  const uploadBtn = document.getElementById("uploadSelectedSpecBtn");

  if (dropzone && fileInput) {
    dropzone.addEventListener("click", () => fileInput.click());

    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });

    dropzone.addEventListener("dragleave", () => {
      dropzone.classList.remove("dragover");
    });

    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleSpecFileSelected(e.dataTransfer.files[0]);
      }
    });

    fileInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleSpecFileSelected(e.target.files[0]);
      }
    });
  }

  if (uploadBtn) {
    uploadBtn.addEventListener("click", () => {
      if (selectedSpecFile) {
        uploadSpecFile(selectedSpecFile);
      }
    });
  }

  function handleSpecFileSelected(file) {
    selectedSpecFile = file;
    selectedFileName.textContent = file.name;
    selectedFileSize.textContent = `${(file.size / 1024).toFixed(1)} KB`;
    selectedFileBox.classList.remove("hidden");
    // Automatically trigger upload & parse for seamless experience
    uploadSpecFile(file);
  }

  // Fetch URL button
  const fetchUrlBtn = document.getElementById("fetchUrlBtn");
  if (fetchUrlBtn) {
    fetchUrlBtn.addEventListener("click", async () => {
      const url = document.getElementById("springBootUrl").value.trim();
      if (!url) return showToast("Please enter a valid Spring Boot / Swagger docs URL.", "warning");

      renderDiagnosticLoading("Fetching & validating from " + url + "...");

      try {
        const res = await fetch("/api/spec/fetch-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        const data = await res.json();
        if (data.valid && data.diagnostics) {
          appConfig.openapiPath = "fetched-openapi.json";
          appConfig.endpointConfigs = {};
          apiEndpoints = data.endpoints || [];
          document.getElementById("endpointSearchInput").value = "";
          renderDiagnostics(data.diagnostics);
          renderEndpointsList();
          showToast(`Successfully fetched & loaded ${apiEndpoints.length} endpoints from ${url}`, "success", "OpenAPI Spec");
        } else {
          renderDiagnosticError(data.diagnostics || { errors: [data.error || "Validation failed"] });
          showToast(data.error || "Validation failed", "error", "Invalid Spec");
        }
      } catch (err) {
        renderDiagnosticError({ errors: ["Failed fetching URL: " + err.message] });
        showToast("Failed fetching URL: " + err.message, "error");
      }
    });
  }

  // Parse Raw JSON button
  const parseRawBtn = document.getElementById("parseRawJsonBtn");
  if (parseRawBtn) {
    parseRawBtn.addEventListener("click", async () => {
      const rawText = document.getElementById("specRawTextarea").value.trim();
      if (!rawText) return showToast("Please paste valid JSON specification text.", "warning");

      renderDiagnosticLoading("Parsing and validating raw JSON...");

      try {
        const res = await fetch("/api/spec/raw", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rawJson: rawText }),
        });
        const data = await res.json();
        if (data.valid && data.diagnostics) {
          appConfig.openapiPath = "raw-openapi.json";
          appConfig.endpointConfigs = {};
          apiEndpoints = data.endpoints || [];
          document.getElementById("endpointSearchInput").value = "";
          renderDiagnostics(data.diagnostics);
          renderEndpointsList();
          showToast(`Raw JSON parsed: ${apiEndpoints.length} endpoints discovered!`, "success", "OpenAPI Spec");
        } else {
          renderDiagnosticError(data.diagnostics || { errors: [data.error || "Validation failed"] });
          showToast(data.error || "Validation failed", "error", "Invalid Spec");
        }
      } catch (err) {
        renderDiagnosticError({ errors: ["JSON parsing failed: " + err.message] });
        showToast("JSON parsing failed: " + err.message, "error");
      }
    });
  }

  // Reload spec button
  const reloadBtn = document.getElementById("reloadSpecBtn");
  if (reloadBtn) {
    reloadBtn.addEventListener("click", () => {
      loadSpecEndpoints();
      showToast("Refreshed active specification", "info");
    });
  }
}

async function uploadSpecFile(file) {
  const formData = new FormData();
  formData.append("spec", file);

  renderDiagnosticLoading("Uploading & validating " + file.name + "...");

  try {
    const res = await fetch("/api/spec/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (data.valid && data.diagnostics) {
      appConfig.openapiPath = "uploaded-openapi.json";
      appConfig.endpointConfigs = {};
      apiEndpoints = data.endpoints || [];
      document.getElementById("endpointSearchInput").value = "";
      renderDiagnostics(data.diagnostics);
      renderEndpointsList();
      showToast(`Uploaded '${file.name}': Discovered ${apiEndpoints.length} endpoints!`, "success", "Spec Uploaded");
    } else {
      renderDiagnosticError(data.diagnostics || { errors: [data.error || "Validation failed"] });
      showToast(data.error || "Validation failed", "error", "Invalid Specification");
    }
  } catch (err) {
    renderDiagnosticError({ errors: ["Failed uploading file: " + err.message] });
    showToast("Failed uploading file: " + err.message, "error");
  } finally {
    const fileInput = document.getElementById("specFileInput");
    if (fileInput) fileInput.value = "";
  }
}

async function loadSpecEndpoints() {
  renderDiagnosticLoading("Inspecting active specification...");
  try {
    const res = await fetch("/api/spec/endpoints");
    const data = await res.json();

    if (data.valid) {
      renderDiagnostics(data);
      apiEndpoints = data.endpoints || [];
      renderEndpointsList();
    } else {
      renderDiagnosticError(data);
    }
  } catch (err) {
    renderDiagnosticError({ errors: ["Could not load specification: " + err.message] });
  }
}

function renderDiagnosticLoading(msg) {
  const badge = document.getElementById("specStatusBadge");
  badge.className = "badge";
  badge.textContent = "Validating...";

  const verdictBadge = document.getElementById("diagVerdictBadge");
  verdictBadge.className = "badge";
  verdictBadge.textContent = "CHECKING...";

  const errorsDiv = document.getElementById("diagErrorsContainer");
  const warningsDiv = document.getElementById("diagWarningsContainer");
  errorsDiv.classList.add("hidden");
  warningsDiv.classList.add("hidden");
}

function renderDiagnostics(data) {
  const specStatusBadge = document.getElementById("specStatusBadge");
  const verdictBadge = document.getElementById("diagVerdictBadge");
  const formatBadge = document.getElementById("diagFormatBadge");
  const endpointCount = document.getElementById("diagEndpointCount");
  const title = document.getElementById("specInfoTitle");
  const version = document.getElementById("specInfoVersion");
  const methodsContainer = document.getElementById("diagMethodsContainer");
  const errorsContainer = document.getElementById("diagErrorsContainer");
  const warningsContainer = document.getElementById("diagWarningsContainer");

  const hasWarnings = data.warnings && data.warnings.length > 0;

  if (hasWarnings) {
    specStatusBadge.className = "badge badge-warning";
    specStatusBadge.textContent = "Warnings";
    verdictBadge.className = "badge badge-warning";
    verdictBadge.textContent = "VALID WITH WARNINGS";
  } else {
    specStatusBadge.className = "badge badge-success";
    specStatusBadge.textContent = "Valid";
    verdictBadge.className = "badge badge-success";
    verdictBadge.textContent = "SPECIFICATION VALID";
  }

  formatBadge.textContent = data.format || "OpenAPI 3.x";
  endpointCount.textContent = `${data.endpointsCount || (data.endpoints ? data.endpoints.length : 0)} endpoints`;
  title.textContent = data.title || "API Specification";
  version.textContent = data.version || "1.0.0";

  // Render method breakdown
  methodsContainer.innerHTML = "";
  if (data.methodCounts && Object.keys(data.methodCounts).length > 0) {
    for (const [method, count] of Object.entries(data.methodCounts)) {
      const tag = document.createElement("span");
      tag.className = `method-badge method-${method}`;
      tag.textContent = `${method}: ${count}`;
      methodsContainer.appendChild(tag);
    }
  }

  // Render warnings if any
  if (hasWarnings) {
    warningsContainer.classList.remove("hidden");
    warningsContainer.innerHTML = `
      <div style="font-size: 11px; font-weight: 700; color: var(--warning-text); margin-bottom: 4px; text-transform: uppercase;">
        Schema Warnings (${data.warnings.length})
      </div>
      ${data.warnings.map((w) => `<div class="diagnostics-item warning">⚠️ ${escapeHtml(w)}</div>`).join("")}
    `;
  } else {
    warningsContainer.classList.add("hidden");
    warningsContainer.innerHTML = "";
  }

  // Hide errors
  errorsContainer.classList.add("hidden");
  errorsContainer.innerHTML = "";
}

function renderDiagnosticError(data) {
  const specStatusBadge = document.getElementById("specStatusBadge");
  const verdictBadge = document.getElementById("diagVerdictBadge");
  const formatBadge = document.getElementById("diagFormatBadge");
  const endpointCount = document.getElementById("diagEndpointCount");
  const title = document.getElementById("specInfoTitle");
  const errorsContainer = document.getElementById("diagErrorsContainer");
  const endpointsList = document.getElementById("endpointListContainer");

  specStatusBadge.className = "badge badge-danger";
  specStatusBadge.textContent = "Invalid";

  verdictBadge.className = "badge badge-danger";
  verdictBadge.textContent = "VALIDATION ERROR";

  formatBadge.textContent = data.format || "Invalid";
  endpointCount.textContent = "0 endpoints";
  title.textContent = data.title || "Specification Error";

  const errorMessages = data.errors || [data.error || "Unknown validation error"];
  errorsContainer.classList.remove("hidden");
  errorsContainer.innerHTML = `
    <div style="font-size: 11px; font-weight: 700; color: var(--danger-text); margin-bottom: 4px; text-transform: uppercase;">
      Diagnostic Errors (${errorMessages.length})
    </div>
    ${errorMessages.map((e) => `<div class="diagnostics-item error">❌ ${escapeHtml(e)}</div>`).join("")}
  `;

  endpointsList.innerHTML = `
    <div style="padding: 24px; text-align: center; color: var(--danger-text); font-family: var(--font-mono); font-size: 12px; border: 1px solid var(--danger-border); background-color: var(--danger-bg); border-radius: var(--radius);">
      <strong>Cannot extract endpoints:</strong> Specification contains errors shown above.<br/>
      Please fix the JSON syntax or provide a valid OpenAPI 3.x / Swagger 2.0 file.
    </div>
  `;
}

// -------------------------------------------------------------
// 7. Endpoints List & Scenarios
// -------------------------------------------------------------
function initEndpointsControls() {
  const searchInput = document.getElementById("endpointSearchInput");
  if (searchInput) searchInput.addEventListener("input", renderEndpointsList);

  const selectAllBtn = document.getElementById("selectAllEndpoints");
  if (selectAllBtn) {
    selectAllBtn.addEventListener("click", () => {
      document.querySelectorAll("#endpointListContainer input[type='checkbox']").forEach((cb) => (cb.checked = true));
      syncEndpointSelection();
      showToast("All endpoints selected", "info");
    });
  }

  const clearBtn = document.getElementById("clearEndpoints");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      document.querySelectorAll("#endpointListContainer input[type='checkbox']").forEach((cb) => (cb.checked = false));
      syncEndpointSelection();
      showToast("All endpoints deselected", "info");
    });
  }
}

function renderEndpointsList() {
  const container = document.getElementById("endpointListContainer");
  container.innerHTML = "";
  const filter = (document.getElementById("endpointSearchInput").value || "").toLowerCase();

  const included = appConfig?.endpoints?.include || ["all"];
  const excluded = appConfig?.endpoints?.exclude || [];
  const epConfigs = appConfig?.endpointConfigs || {};

  if (!apiEndpoints || apiEndpoints.length === 0) {
    container.innerHTML = `
      <div style="color: var(--text-muted); font-size: 12px; text-align: center; padding: 24px;">
        No endpoints discovered in active specification.
      </div>
    `;
    return;
  }

  apiEndpoints.forEach((ep) => {
    const matchesSearch =
      ep.route.toLowerCase().includes(filter) ||
      ep.method.toLowerCase().includes(filter) ||
      ep.opId.toLowerCase().includes(filter) ||
      ep.tag.toLowerCase().includes(filter) ||
      ep.summary.toLowerCase().includes(filter);

    if (!matchesSearch) return;

    let isChecked = false;
    if (included.includes("all")) {
      isChecked = !excluded.includes(ep.opId);
    } else {
      isChecked = included.includes(ep.opId) && !excluded.includes(ep.opId);
    }

    const hasCustom = !!epConfigs[ep.opId];
    const isMutating = ["POST", "PUT", "PATCH"].includes(ep.method);

    const row = document.createElement("div");
    row.className = `endpoint-row ${!isChecked ? "disabled" : ""}`;
    row.id = `ep-row-${ep.opId}`;

    row.innerHTML = `
      <div class="endpoint-left">
        <input type="checkbox" class="endpoint-checkbox" data-opid="${ep.opId}" ${isChecked ? "checked" : ""} />
        <span class="method-badge method-${ep.method}">${ep.method}</span>
        <div class="endpoint-details">
          <div class="endpoint-route-row">
            <span class="endpoint-route">${escapeHtml(ep.route)}</span>
            <span class="badge" style="font-size: 10px; padding: 1px 5px;">${escapeHtml(ep.tag)}</span>
          </div>
          <div class="endpoint-summary">${escapeHtml(ep.summary || ep.route)}</div>
        </div>
      </div>
      <div class="endpoint-right">
        ${
          ep.hasBody || isMutating
            ? `<span class="endpoint-body-badge ${hasCustom ? "active" : ""}">
                 ${hasCustom ? "Custom Data" : "Schema Body"}
               </span>`
            : `<span class="endpoint-body-badge">No Body</span>`
        }
        <button type="button" class="btn btn-sm btn-secondary configure-ep-btn" data-opid="${ep.opId}">
          Configure Data & Status ⚙
        </button>
      </div>
    `;

    // Checkbox toggle
    const checkbox = row.querySelector(".endpoint-checkbox");
    checkbox.addEventListener("change", () => {
      row.classList.toggle("disabled", !checkbox.checked);
      syncEndpointSelection();
    });

    // Configure modal button
    row.querySelector(".configure-ep-btn").addEventListener("click", () => {
      openEndpointModal(ep);
    });

    container.appendChild(row);
  });
}

function syncEndpointSelection() {
  const checkboxes = document.querySelectorAll("#endpointListContainer .endpoint-checkbox");
  const selected = [];
  const unselected = [];

  checkboxes.forEach((cb) => {
    if (cb.checked) selected.push(cb.dataset.opid);
    else unselected.push(cb.dataset.opid);
  });

  if (!appConfig.endpoints) appConfig.endpoints = {};

  if (unselected.length === 0) {
    appConfig.endpoints.include = ["all"];
    appConfig.endpoints.exclude = [];
  } else {
    appConfig.endpoints.include = selected;
    appConfig.endpoints.exclude = unselected;
  }
}

// -------------------------------------------------------------
// 8. Endpoint Scenario Modal
// -------------------------------------------------------------
function initModalControls() {
  document.getElementById("closeModalBtn").addEventListener("click", closeEndpointModal);

  document.getElementById("savePayloadModalBtn").addEventListener("click", () => {
    if (!currentEditingEndpoint) return;
    const opId = currentEditingEndpoint.opId;

    if (!appConfig.endpointConfigs) appConfig.endpointConfigs = {};
    if (!appConfig.endpointConfigs[opId]) appConfig.endpointConfigs[opId] = {};

    // Save status codes
    const selectedStatuses = [];
    document.querySelectorAll("#expectedStatusCheckboxes input[type='checkbox']:checked").forEach((cb) => {
      selectedStatuses.push(parseInt(cb.value, 10));
    });
    if (selectedStatuses.length > 0) {
      appConfig.endpointConfigs[opId].expectedStatus = selectedStatuses;
    }

    // Save payload if editable
    const isMutating = ["POST", "PUT", "PATCH"].includes(currentEditingEndpoint.method);
    if (currentEditingEndpoint.hasBody || isMutating) {
      const payloadText = document.getElementById("modalPayloadEditor").value.trim();
      if (payloadText) {
        try {
          const parsed = JSON.parse(payloadText);
          appConfig.endpointConfigs[opId].body = parsed;
        } catch (err) {
          return showToast("Invalid JSON payload in editor: " + err.message, "error");
        }
      } else {
        delete appConfig.endpointConfigs[opId].body;
      }
    }

    closeEndpointModal();
    renderEndpointsList();
    showToast(`Updated scenario configuration for ${currentEditingEndpoint.route}`, "success");
  });

  document.getElementById("resetPayloadBtn").addEventListener("click", () => {
    if (!currentEditingEndpoint) return;
    const defaultBody = currentEditingEndpoint.defaultBody || { sample: "value" };
    document.getElementById("modalPayloadEditor").value = JSON.stringify(defaultBody, null, 2);
    showToast("Payload reset to schema default", "info");
  });

  // Dynamic variable insertion buttons
  document.querySelectorAll(".tag-btn[data-tag]").forEach((btn) => {
    btn.addEventListener("click", () => {
      insertTagIntoTextarea(btn.dataset.tag);
    });
  });
}

function openEndpointModal(ep) {
  currentEditingEndpoint = ep;
  const modal = document.getElementById("endpointModal");
  modal.classList.remove("hidden");

  document.getElementById("modalEndpointTitle").textContent = `Configure Scenario: ${ep.opId}`;
  document.getElementById("modalRouteText").textContent = ep.route;

  const badge = document.getElementById("modalMethodBadge");
  badge.className = `method-badge method-${ep.method}`;
  badge.textContent = ep.method;

  const customCfg = appConfig.endpointConfigs?.[ep.opId] || {};

  // Status checkboxes
  const expected = customCfg.expectedStatus || ep.expectedStatus || (ep.method === "POST" ? [200, 201] : [200, 201, 204]);
  document.querySelectorAll("#expectedStatusCheckboxes input[type='checkbox']").forEach((cb) => {
    cb.checked = expected.includes(parseInt(cb.value, 10));
  });

  // Payload editor
  const payloadSection = document.getElementById("modalPayloadSection");
  const editor = document.getElementById("modalPayloadEditor");
  const isMutating = ["POST", "PUT", "PATCH"].includes(ep.method);

  if (ep.hasBody || isMutating) {
    payloadSection.classList.remove("hidden");
    const bodyObj = customCfg.body !== undefined ? customCfg.body : ep.defaultBody || {};
    editor.value = JSON.stringify(bodyObj, null, 2);
  } else {
    payloadSection.classList.add("hidden");
  }

  updateDatasetColumnTagsInModal();
}

function closeEndpointModal() {
  document.getElementById("endpointModal").classList.add("hidden");
  currentEditingEndpoint = null;
}

function insertTagIntoTextarea(tag) {
  const textarea = document.getElementById("modalPayloadEditor");
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  textarea.value = text.substring(0, start) + `"${tag}"` + text.substring(end);
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = start + tag.length + 2;
}

function updateDatasetColumnTagsInModal() {
  const container = document.getElementById("datasetColumnTags");
  container.innerHTML = "";
  if (activeDataset && Array.isArray(activeDataset.columns) && activeDataset.columns.length > 0) {
    activeDataset.columns.forEach((col) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tag-btn dataset-tag";
      btn.textContent = `+ ${col}`;
      btn.title = `Injects unique column '${col}' from uploaded test dataset`;
      btn.addEventListener("click", () => {
        insertTagIntoTextarea(`{{dataset.${col}}}`);
      });
      container.appendChild(btn);
    });
  } else {
    container.innerHTML = `<span style="font-size: 11px; color: var(--text-dim); font-family: var(--font-mono);">No active dataset loaded</span>`;
  }
}

// -------------------------------------------------------------
// 9. Parameterized Dataset Feeder & Safe Removal
// -------------------------------------------------------------
function initDatasetControls() {
  const uploadBtn = document.getElementById("uploadDatasetBtn");
  if (uploadBtn) {
    uploadBtn.addEventListener("click", async () => {
      const fileInput = document.getElementById("datasetFileInput");
      const file = fileInput.files[0];
      if (!file) return showToast("Please select a .csv or .json dataset file to upload.", "warning");

      const formData = new FormData();
      formData.append("dataset", file);

      try {
        const res = await fetch("/api/dataset/upload", { method: "POST", body: formData });
        const data = await res.json();
        if (data.success) {
          appConfig.datasetPath = data.datasetPath;
          await loadDatasetInfo();
          showToast(`Dataset '${data.filename}' loaded with ${data.totalCount} records!`, "success", "Dataset Ready");
        } else {
          showToast(data.error || "Failed uploading dataset", "error");
        }
      } catch (e) {
        showToast("Dataset upload failed: " + e.message, "error");
      }
    });
  }

  const removeBtn = document.getElementById("removeDatasetBtn");
  if (removeBtn) {
    removeBtn.addEventListener("click", async () => {
      try {
        const res = await fetch("/api/dataset", { method: "DELETE" });
        const data = await res.json();
        if (data.success) {
          delete appConfig.datasetPath;
          activeDataset = null;
          await loadDatasetInfo();
          showToast("Dataset detached from active configuration", "info", "Dataset Removed");
        } else {
          showToast(data.error || "Failed removing dataset", "error");
        }
      } catch (e) {
        showToast("Error removing dataset: " + e.message, "error");
      }
    });
  }
}

async function loadDatasetInfo() {
  try {
    const res = await fetch("/api/dataset");
    const data = await res.json();
    const badge = document.getElementById("datasetBadge");
    const infoBox = document.getElementById("datasetInfoBox");

    if (data.hasDataset) {
      activeDataset = data;
      badge.className = "badge badge-success";
      badge.textContent = "Active";
      infoBox.classList.remove("hidden");

      document.getElementById("datasetFileName").textContent = data.filename;
      document.getElementById("datasetTotalRows").textContent = `${data.totalCount} records available`;
      document.getElementById("datasetColumnsList").textContent = data.columns.join(", ");
    } else {
      activeDataset = null;
      badge.className = "badge";
      badge.textContent = "None Loaded";
      infoBox.classList.add("hidden");
      document.getElementById("datasetFileInput").value = "";
    }
  } catch (err) {
    console.error("Failed loading dataset info:", err);
  }
}

// -------------------------------------------------------------
// 10. Concurrency Profile, Stages & Flat Canvas
// -------------------------------------------------------------
function setLoadMode(mode) {
  document.querySelectorAll("[data-load-mode]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.loadMode === mode);
  });
  document.getElementById("stagesModeContainer").classList.toggle("hidden", mode !== "stages");
  document.getElementById("flatModeContainer").classList.toggle("hidden", mode !== "flat");
  if (appConfig?.load) appConfig.load.mode = mode;
  drawLoadCurve();
}

function initStagesControls() {
  document.querySelectorAll("[data-load-mode]").forEach((btn) => {
    btn.addEventListener("click", () => setLoadMode(btn.dataset.loadMode));
  });

  document.getElementById("addStageBtn").addEventListener("click", () => {
    addStageRow({ duration: "30s", target: 20 });
    drawLoadCurve();
  });

  document.getElementById("flatVus").addEventListener("input", drawLoadCurve);
  document.getElementById("flatDuration").addEventListener("input", drawLoadCurve);
}

function renderStagesRows(stages) {
  const tbody = document.getElementById("stagesTableBody");
  tbody.innerHTML = "";
  stages.forEach((stg) => addStageRow(stg));
}

function addStageRow(stage = { duration: "30s", target: 10 }) {
  const tbody = document.getElementById("stagesTableBody");
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>
      <input type="text" class="stage-duration" value="${stage.duration}" placeholder="30s, 1m" style="padding: 6px 10px;" />
    </td>
    <td>
      <input type="number" class="stage-target" value="${stage.target}" min="0" max="10000" style="padding: 6px 10px;" />
    </td>
    <td>
      <button type="button" class="btn btn-sm btn-dark remove-stage-btn" style="color: var(--danger);">✕</button>
    </td>
  `;

  tr.querySelector(".stage-duration").addEventListener("input", drawLoadCurve);
  tr.querySelector(".stage-target").addEventListener("input", drawLoadCurve);
  tr.querySelector(".remove-stage-btn").addEventListener("click", () => {
    tr.remove();
    drawLoadCurve();
  });

  tbody.appendChild(tr);
}

function getStagesFromUI() {
  const rows = document.querySelectorAll("#stagesTableBody tr");
  const stages = [];
  rows.forEach((r) => {
    const dur = r.querySelector(".stage-duration").value || "30s";
    const tgt = parseInt(r.querySelector(".stage-target").value, 10) || 0;
    stages.push({ duration: dur, target: tgt });
  });
  return stages;
}

// Flat Solid Canvas Drawing (Zero Gradients!)
function drawLoadCurve() {
  const canvas = document.getElementById("loadCurveCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = (canvas.width = canvas.parentElement.clientWidth || 300);
  const h = (canvas.height = 70);

  ctx.clearRect(0, 0, w, h);

  const isStages = !document.getElementById("stagesModeContainer").classList.contains("hidden");
  let points = [];

  if (isStages) {
    const stages = getStagesFromUI();
    points.push({ time: 0, vus: 0 });
    let cumulativeTime = 0;
    stages.forEach((s) => {
      let seconds = 30;
      if (s.duration.endsWith("s")) seconds = parseInt(s.duration, 10) || 30;
      else if (s.duration.endsWith("m")) seconds = (parseInt(s.duration, 10) || 1) * 60;
      cumulativeTime += seconds;
      points.push({ time: cumulativeTime, vus: s.target });
    });
  } else {
    const vus = parseInt(document.getElementById("flatVus").value, 10) || 20;
    points = [
      { time: 0, vus: 0 },
      { time: 5, vus: vus },
      { time: 55, vus: vus },
      { time: 60, vus: 0 },
    ];
  }

  if (points.length === 0) return;

  const isDark = document.documentElement.classList.contains("dark");
  const maxVus = Math.max(...points.map((p) => p.vus), 10);
  const maxTime = Math.max(...points.map((p) => p.time), 10);

  // Background baseline
  ctx.strokeStyle = isDark ? "#323238" : "#E2E8F0";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h - 5);
  ctx.lineTo(w, h - 5);
  ctx.stroke();

  // Solid flat fill area (No Gradients!)
  ctx.beginPath();
  points.forEach((p, idx) => {
    const x = (p.time / maxTime) * (w - 20) + 10;
    const y = h - 10 - (p.vus / maxVus) * (h - 24);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(w - 10, h - 5);
  ctx.lineTo(10, h - 5);
  ctx.closePath();
  ctx.fillStyle = isDark ? "#2D1C13" : "#FFF7ED"; // Warm terracotta tint
  ctx.fill();

  // Solid flat curve stroke
  ctx.beginPath();
  ctx.strokeStyle = isDark ? "#D97736" : "#C25E1A"; // Solid rusty orange
  ctx.lineWidth = 2;
  points.forEach((p, idx) => {
    const x = (p.time / maxTime) * (w - 20) + 10;
    const y = h - 10 - (p.vus / maxVus) * (h - 24);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Draw points
  points.forEach((p) => {
    const x = (p.time / maxTime) * (w - 20) + 10;
    const y = h - 10 - (p.vus / maxVus) * (h - 24);
    ctx.fillStyle = isDark ? "#D97736" : "#C25E1A";
    ctx.fillRect(x - 2, y - 2, 4, 4);
  });
}

// -------------------------------------------------------------
// 11. Actions, Config Saving & Execution
// -------------------------------------------------------------
function initActions() {
  document.getElementById("saveConfigBtn").addEventListener("click", saveCurrentConfig);
  document.getElementById("launchTestBtn").addEventListener("click", startPerformanceTest);
  document.getElementById("headerQuickRunBtn").addEventListener("click", startPerformanceTest);

  // Clear & Copy logs
  document.getElementById("clearLogsBtn").addEventListener("click", () => {
    document.getElementById("terminalOutput").innerHTML = "";
    showToast("Terminal logs cleared", "info");
  });
  document.getElementById("copyLogsBtn").addEventListener("click", () => {
    navigator.clipboard.writeText(document.getElementById("terminalOutput").innerText);
    showToast("Terminal logs copied to clipboard!", "success");
  });

  // Abort execution buttons
  document.getElementById("abortTestBtn").addEventListener("click", abortTest);
  document.getElementById("headerAbortBtn").addEventListener("click", abortTest);

  // Refresh reports
  document.getElementById("refreshReportBtn").addEventListener("click", () => {
    refreshIframes();
    showToast("Executive report refreshed", "info");
  });
  document.getElementById("refreshAllureBtn").addEventListener("click", () => {
    refreshIframes();
    showToast("Allure report refreshed", "info");
  });
  document.getElementById("refreshHistoryBtn").addEventListener("click", () => {
    loadRunHistory();
    showToast("Run history refreshed", "info");
  });
}

function collectConfigFromUI() {
  syncEndpointSelection();

  const cfg = { ...appConfig };
  cfg.baseUrl = document.getElementById("baseUrlInput").value.trim() || "http://localhost:8080";

  if (!cfg.run) cfg.run = {};
  cfg.run.buildLabel = document.getElementById("buildLabelInput").value.trim() || "release";
  cfg.run.environment = document.getElementById("environmentInput").value.trim() || "staging";

  if (!cfg.headers) cfg.headers = {};
  const token = document.getElementById("authTokenInput").value.trim();
  if (token) {
    cfg.headers["Authorization"] = `Bearer ${token}`;
  } else {
    delete cfg.headers["Authorization"];
  }

  const rawHeaders = document.getElementById("customHeadersInput").value.trim();
  if (rawHeaders) {
    try {
      const parsed = JSON.parse(rawHeaders);
      Object.assign(cfg.headers, parsed);
    } catch (e) {
      console.warn("Invalid custom headers JSON:", e);
    }
  }

  if (!cfg.thresholds) cfg.thresholds = {};
  cfg.thresholds.p95Ms = parseInt(document.getElementById("p95Threshold").value, 10) || 500;
  cfg.thresholds.p99Ms = parseInt(document.getElementById("p99Threshold").value, 10) || 1000;
  cfg.thresholds.maxErrorRate = (parseFloat(document.getElementById("maxErrorRate").value) || 1.0) / 100;

  if (!cfg.contractTesting) cfg.contractTesting = {};
  cfg.contractTesting.enabled = document.getElementById("contractEnabledCheckbox").checked;

  const isStages = !document.getElementById("stagesModeContainer").classList.contains("hidden");
  if (!cfg.load) cfg.load = {};
  if (isStages) {
    cfg.load.mode = "stages";
    cfg.load.stages = getStagesFromUI();
  } else {
    cfg.load.mode = "flat";
    cfg.load.vus = parseInt(document.getElementById("flatVus").value, 10) || 20;
    cfg.load.duration = document.getElementById("flatDuration").value.trim() || "30s";
  }

  return cfg;
}

async function saveCurrentConfig() {
  const cfg = collectConfigFromUI();
  try {
    await saveConfigToServer(cfg);
    showToast("Studio configuration saved successfully!", "success", "Saved");
  } catch (err) {
    showToast("Failed saving configuration: " + err.message, "error");
  }
}

async function saveConfigToServer(cfg) {
  const res = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg, null, 2),
  });
  if (!res.ok) throw new Error("Server responded with " + res.status);
  appConfig = cfg;
}

async function startPerformanceTest() {
  const cfg = collectConfigFromUI();
  switchTab("console");

  try {
    const res = await fetch("/api/pipeline/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed starting pipeline");
    showToast("Load test execution started!", "info", "Pipeline");
  } catch (err) {
    showToast("Execution error: " + err.message, "error");
  }
}

async function abortTest() {
  if (confirm("Abort the active load test pipeline immediately?")) {
    try {
      await fetch("/api/pipeline/stop", { method: "POST" });
      showToast("Pipeline abort requested", "warning");
    } catch (err) {
      showToast("Failed aborting test: " + err.message, "error");
    }
  }
}

// -------------------------------------------------------------
// 12. WebSockets & Real-Time Log Streaming
// -------------------------------------------------------------
function initWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    document.getElementById("wsStatusDot").className = "status-dot active";
    document.getElementById("wsStatusText").textContent = "Connected";
  };

  ws.onclose = () => {
    document.getElementById("wsStatusDot").className = "status-dot";
    document.getElementById("wsStatusText").textContent = "Offline (Reconnecting...)";
    setTimeout(initWebSocket, 3000);
  };

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      handleWebSocketMessage(msg);
    } catch (e) {
      console.error(e);
    }
  };
}

function handleWebSocketMessage(msg) {
  switch (msg.type) {
    case "init":
      if (msg.data.running) setPipelineRunningState(true);
      if (msg.data.mockRunning !== undefined) updateMockServerUI(msg.data.mockRunning);
      if (msg.data.dbStatus) updateDbStatusUI(msg.data.dbStatus);
      break;

    case "pipeline_started":
      setPipelineRunningState(true);
      appendLogLine("[system] 🚀 Pipeline execution initiated...", "highlight");
      break;

    case "pipeline_finished":
      setPipelineRunningState(false);
      const isPassed = msg.data.exitCode === 0;
      const verdict = isPassed ? "PASSED (SLA Satisfied)" : "FAILED (SLA Breached / Errors)";
      appendLogLine(`[system] 🏁 Pipeline finished with exit code ${msg.data.exitCode} — ${verdict}`, isPassed ? "success" : "stderr");
      showToast(verdict, isPassed ? "success" : "error", "Benchmark Completed");
      loadRunHistory();
      loadAnalytics();
      refreshIframes();
      break;

    case "run_saved":
      if (msg.data.storedInPostgres) {
        showToast("Test run metrics & timeseries saved to PostgreSQL", "success", "🐘 Database Saved");
      }
      loadRunHistory();
      loadAnalytics();
      break;

    case "pipeline_aborted":
      setPipelineRunningState(false);
      appendLogLine(`[system] ⛔ ${msg.data.message}`, "stderr");
      showToast(msg.data.message, "error", "Aborted");
      break;

    case "mock_status":
      updateMockServerUI(msg.data.running);
      break;

    case "log":
      appendLogLine(msg.data.text, msg.data.stream === "stderr" ? "stderr" : "");
      break;
  }
}

function setPipelineRunningState(isRunning) {
  const statusDot = document.getElementById("pipelineStatusDot");
  const statusText = document.getElementById("pipelineStatusText");
  const timer = document.getElementById("pipelineTimer");
  const headerQuickBtn = document.getElementById("headerQuickRunBtn");
  const headerAbortBtn = document.getElementById("headerAbortBtn");
  const launchBtn = document.getElementById("launchTestBtn");
  const abortBtn = document.getElementById("abortTestBtn");

  if (isRunning) {
    statusDot.className = "status-dot running";
    statusText.textContent = "RUNNING";
    timer.classList.remove("hidden");
    headerQuickBtn.classList.add("hidden");
    headerAbortBtn.classList.remove("hidden");
    abortBtn.classList.remove("hidden");
    launchBtn.disabled = true;

    runStartTime = Date.now();
    clearInterval(runTimerInterval);
    runTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - runStartTime) / 1000);
      const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const secs = String(elapsed % 60).padStart(2, "0");
      timer.textContent = `(${mins}:${secs})`;
    }, 1000);
  } else {
    statusDot.className = "status-dot";
    statusText.textContent = "IDLE";
    timer.classList.add("hidden");
    headerQuickBtn.classList.remove("hidden");
    headerAbortBtn.classList.add("hidden");
    abortBtn.classList.add("hidden");
    launchBtn.disabled = false;
    clearInterval(runTimerInterval);
  }
}

function appendLogLine(text, cssClass = "") {
  const terminal = document.getElementById("terminalOutput");
  const div = document.createElement("div");
  div.className = `log-line ${cssClass}`;
  div.textContent = text;
  terminal.appendChild(div);
  terminal.scrollTop = terminal.scrollHeight;
}

// -------------------------------------------------------------
// 13. Run History
// -------------------------------------------------------------
async function loadRunHistory() {
  try {
    const res = await fetch("/api/runs");
    const data = await res.json();
    const history = Array.isArray(data) ? data : (data.runs || []);
    const tbody = document.getElementById("historyTableBody");
    tbody.innerHTML = "";

    if (!Array.isArray(history) || history.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="11" style="text-align: center; color: var(--text-muted); padding: 30px;">
            No runs recorded yet. Execute a load test to generate history.
          </td>
        </tr>
      `;
      return;
    }

    history.forEach((run) => {
      const tr = document.createElement("tr");
      const d = new Date(run.date);
      const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const dateStr = d.toLocaleDateString();
      const isPg = run.source === "postgresql" || run.storedInPostgres;

      tr.innerHTML = `
        <td>${dateStr} ${timeStr}</td>
        <td><span class="badge">${escapeHtml(run.buildLabel || "build")}</span></td>
        <td><span class="badge">${escapeHtml(run.environment || "staging")}</span></td>
        <td>
          <span class="badge ${run.passed ? "badge-success" : "badge-danger"}">
            ${run.passed ? "PASSED" : "FAILED"}
          </span>
        </td>
        <td>${run.peakVus} VUs</td>
        <td>${Number(run.throughput).toFixed(1)} req/s</td>
        <td style="color: ${run.p95 > 500 ? "var(--danger)" : "inherit"};">${Math.round(run.p95)} ms</td>
        <td style="color: ${run.p99 > 1000 ? "var(--danger)" : "inherit"};">${Math.round(run.p99)} ms</td>
        <td style="color: ${run.errorRate > 1 ? "var(--danger)" : "inherit"};">${run.errorRate}%</td>
        <td>
          <span class="badge ${isPg ? "badge-primary" : ""}" title="${isPg ? "Stored in PostgreSQL" : "Local File Backup"}">
            ${isPg ? "🐘 Postgres" : "📁 File"}
          </span>
        </td>
        <td>
          <button class="btn btn-secondary btn-sm" onclick="inspectRun('${run.id}')" title="Inspect Dynamic Timeseries Graphs" style="padding: 3px 8px; font-size: 11px;">
            📈 Inspect
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error("Failed loading history:", err);
  }
}

// -------------------------------------------------------------
// 14. PostgreSQL Analytics & Dynamic Graphing Engine
// -------------------------------------------------------------
let regressionTrendsChart = null;
let runTimeseriesChart = null;

async function checkDatabaseStatus() {
  try {
    const res = await fetch("/api/db/status");
    const status = await res.json();
    updateDbStatusUI(status);
  } catch (err) {
    updateDbStatusUI({ connected: false, error: err.message });
  }
}

function updateDbStatusUI(status) {
  const dot = document.getElementById("dbStatusDot");
  const text = document.getElementById("dbStatusText");
  const indicator = document.getElementById("dbStatusIndicator");
  const targetLabel = document.getElementById("analyticsDbTarget");

  if (status && status.connected) {
    if (dot) dot.className = "status-dot status-dot-connected";
    if (text) text.textContent = "🐘 DB: Connected";
    if (indicator) {
      indicator.title = `PostgreSQL Connected: ${status.database} on ${status.host}:${status.port}\nVersion: ${status.version || 'v17'}`;
    }
    if (targetLabel) targetLabel.textContent = `${status.database} (${status.host}:${status.port})`;
  } else {
    if (dot) dot.className = "status-dot status-dot-offline";
    if (text) text.textContent = "🐘 DB: Offline";
    if (indicator) {
      indicator.title = `PostgreSQL Disconnected: ${status?.error || 'Connection failed'}. Running in local file fallback mode.`;
    }
    if (targetLabel) targetLabel.textContent = "Offline (Local fallback)";
  }
}

function initAnalytics() {
  const envFilter = document.getElementById("analyticsEnvFilter");
  if (envFilter) {
    envFilter.addEventListener("change", () => loadAnalytics());
  }

  const refreshBtn = document.getElementById("refreshAnalyticsBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      showToast("Refreshing regression trends & analytics...", "info", "Analytics");
      loadAnalytics();
    });
  }

  const runSelect = document.getElementById("analyticsRunSelect");
  if (runSelect) {
    runSelect.addEventListener("change", (e) => {
      if (e.target.value) {
        loadRunInspector(e.target.value);
      }
    });
  }
}

async function loadAnalytics() {
  try {
    const env = document.getElementById("analyticsEnvFilter")?.value || "all";
    const [trendsRes, runsRes] = await Promise.all([
      fetch(`/api/analytics/trends?env=${encodeURIComponent(env)}`),
      fetch(`/api/runs?env=${encodeURIComponent(env)}&limit=50`)
    ]);

    const trends = await trendsRes.json();
    const runsData = await runsRes.json();
    const runs = runsData.runs || [];

    // 1. Calculate KPIs
    const totalRuns = runsData.total || runs.length || 0;
    const kpiRunsEl = document.getElementById("kpiTotalRuns");
    if (kpiRunsEl) kpiRunsEl.textContent = totalRuns;

    const kpiRunsSub = document.getElementById("kpiRunsSubtext");
    if (kpiRunsSub) {
      kpiRunsSub.textContent = runsData.source === "postgresql" ? "PostgreSQL Relational DB" : "Local File Fallback";
    }

    if (runs.length > 0) {
      const passedRuns = runs.filter(r => r.passed).length;
      const successRate = ((passedRuns / runs.length) * 100).toFixed(1);
      const kpiSuccess = document.getElementById("kpiSuccessRate");
      if (kpiSuccess) {
        kpiSuccess.textContent = `${successRate}%`;
        kpiSuccess.className = `analytics-kpi-value ${Number(successRate) >= 90 ? "text-success" : "text-danger"}`;
      }

      const sumP95 = runs.reduce((s, r) => s + (Number(r.p95) || 0), 0);
      const avgP95 = Math.round(sumP95 / runs.length);
      const kpiMean = document.getElementById("kpiMeanP95");
      if (kpiMean) kpiMean.textContent = `${avgP95} ms`;

      const maxVus = runs.reduce((m, r) => Math.max(m, Number(r.peakVus) || 0), 0);
      const kpiVus = document.getElementById("kpiPeakVus");
      if (kpiVus) kpiVus.textContent = `${maxVus} VUs`;
    } else {
      const kpiSuccess = document.getElementById("kpiSuccessRate");
      if (kpiSuccess) kpiSuccess.textContent = "—%";
      const kpiMean = document.getElementById("kpiMeanP95");
      if (kpiMean) kpiMean.textContent = "— ms";
      const kpiVus = document.getElementById("kpiPeakVus");
      if (kpiVus) kpiVus.textContent = "0 VUs";
    }

    // 2. Render Trends Line Chart
    renderRegressionTrendsChart(Array.isArray(trends) ? trends : []);

    // 3. Populate Run Selector for Timeseries Inspector
    const select = document.getElementById("analyticsRunSelect");
    if (select) {
      const previousValue = select.value;
      select.innerHTML = "";
      if (runs.length === 0) {
        select.innerHTML = `<option value="">No test runs available</option>`;
      } else {
        runs.forEach(r => {
          const opt = document.createElement("option");
          opt.value = r.id;
          const d = new Date(r.date);
          const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          opt.textContent = `#${r.runNumber || '-'} [${r.buildLabel || 'build'}] (${r.environment || 'staging'}) - p95: ${Math.round(r.p95)}ms @ ${time}`;
          select.appendChild(opt);
        });

        // Retain or select first
        if (previousValue && runs.some(r => r.id === previousValue)) {
          select.value = previousValue;
          loadRunInspector(previousValue);
        } else {
          select.value = runs[0].id;
          loadRunInspector(runs[0].id);
        }
      }
    }
  } catch (err) {
    console.error("loadAnalytics error:", err);
  }
}

function renderRegressionTrendsChart(trends) {
  const canvas = document.getElementById("regressionTrendsChart");
  if (!canvas || typeof Chart === "undefined") return;

  if (regressionTrendsChart) {
    regressionTrendsChart.destroy();
    regressionTrendsChart = null;
  }

  const isDark = document.documentElement.classList.contains("dark");
  const textColor = isDark ? "#E4E4E7" : "#0F172A";
  const gridColor = isDark ? "#2E2E34" : "#E2E8F0";

  const labels = trends.map(t => `${t.build_label || 'build'} (#${t.run_number || '-'})`);
  const p95Data = trends.map(t => Number(t.p95_latency_ms || 0));
  const avgData = trends.map(t => Number(t.avg_latency_ms || 0));
  const tpsData = trends.map(t => Number(t.throughput_rps || 0));

  regressionTrendsChart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "p95 Latency (ms)",
          data: p95Data,
          borderColor: "#C25E1A",
          backgroundColor: "rgba(194, 94, 26, 0.12)",
          borderWidth: 2,
          pointBackgroundColor: "#C25E1A",
          pointRadius: 4,
          tension: 0.2,
          yAxisID: "yLatency"
        },
        {
          label: "Avg Latency (ms)",
          data: avgData,
          borderColor: "#D97706",
          borderWidth: 1.5,
          borderDash: [4, 4],
          pointRadius: 3,
          tension: 0.2,
          yAxisID: "yLatency"
        },
        {
          label: "Throughput (req/s)",
          data: tpsData,
          borderColor: "#2563EB",
          backgroundColor: "rgba(37, 99, 235, 0.08)",
          borderWidth: 2,
          pointBackgroundColor: "#2563EB",
          pointRadius: 4,
          tension: 0.2,
          yAxisID: "yThroughput"
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          labels: { color: textColor, font: { family: "JetBrains Mono", size: 11 } }
        },
        tooltip: {
          padding: 10,
          titleFont: { family: "JetBrains Mono" },
          bodyFont: { family: "JetBrains Mono" }
        }
      },
      scales: {
        x: {
          grid: { color: gridColor },
          ticks: { color: textColor, font: { family: "JetBrains Mono", size: 10 } }
        },
        yLatency: {
          type: "linear",
          position: "left",
          title: { display: true, text: "Latency (ms)", color: textColor, font: { size: 11 } },
          grid: { color: gridColor },
          ticks: { color: textColor, font: { family: "JetBrains Mono", size: 10 } },
          min: 0
        },
        yThroughput: {
          type: "linear",
          position: "right",
          title: { display: true, text: "Throughput (req/s)", color: textColor, font: { size: 11 } },
          grid: { drawOnChartArea: false },
          ticks: { color: textColor, font: { family: "JetBrains Mono", size: 10 } },
          min: 0
        }
      }
    }
  });
}

async function loadRunInspector(runId) {
  try {
    const [runRes, tsRes] = await Promise.all([
      fetch(`/api/runs/${runId}`),
      fetch(`/api/runs/${runId}/timeseries`)
    ]);

    if (!runRes.ok) return;
    const run = await runRes.json();
    const timeseries = tsRes.ok ? await tsRes.json() : [];

    // Populate Meta Strip
    const b = document.getElementById("inspBuild");
    if (b) b.textContent = run.build_label || "v1.0.0";
    const e = document.getElementById("inspEnv");
    if (e) e.textContent = run.environment || "staging";
    const v = document.getElementById("inspVerdict");
    if (v) {
      v.textContent = run.sla_verdict || (run.passed ? "PASSED" : "FAILED");
      v.className = run.passed ? "text-success" : "text-danger";
    }
    const d = document.getElementById("inspDuration");
    if (d) d.textContent = `${run.duration_seconds || 0}s`;
    const tp = document.getElementById("inspThroughput");
    if (tp) tp.textContent = `${Number(run.throughput_rps || 0).toFixed(1)} req/s`;
    const tr = document.getElementById("inspTotalReqs");
    if (tr) tr.textContent = Number(run.total_requests || 0).toLocaleString();
    const er = document.getElementById("inspErrorRate");
    if (er) er.textContent = `${Number(run.error_rate || 0).toFixed(2)}%`;

    // Render Timeseries Chart
    renderTimeseriesChart(timeseries);

    // Render Endpoints Table
    const tbody = document.getElementById("analyticsEndpointsTableBody");
    if (tbody) {
      tbody.innerHTML = "";
      const endpoints = run.endpoints || [];

      if (endpoints.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 16px;">No endpoint metrics recorded for this run.</td></tr>`;
        return;
      }

      endpoints.forEach(ep => {
        const row = document.createElement("tr");
        const passed = !ep.threshold_breached;
        row.innerHTML = `
          <td><span class="method-badge method-${(ep.method || 'GET').toLowerCase()}">${ep.method || 'GET'}</span></td>
          <td><strong>${escapeHtml(ep.route || ep.op_id)}</strong></td>
          <td>${Math.round(ep.avg_ms)} ms</td>
          <td>${Math.round(ep.p90_ms)} ms</td>
          <td style="font-weight: 700; color: ${ep.p95_ms > 500 ? 'var(--danger)' : 'inherit'};">${Math.round(ep.p95_ms)} ms</td>
          <td>${Math.round(ep.p99_ms)} ms</td>
          <td>${Math.round(ep.max_ms)} ms</td>
          <td>
            <span class="badge ${passed ? 'badge-success' : 'badge-danger'}">
              ${passed ? 'PASSED' : 'BREACHED'}
            </span>
          </td>
        `;
        tbody.appendChild(row);
      });
    }
  } catch (err) {
    console.error("loadRunInspector error:", err);
  }
}

function renderTimeseriesChart(timeseries) {
  const canvas = document.getElementById("runTimeseriesChart");
  if (!canvas || typeof Chart === "undefined") return;

  if (runTimeseriesChart) {
    runTimeseriesChart.destroy();
    runTimeseriesChart = null;
  }

  const isDark = document.documentElement.classList.contains("dark");
  const textColor = isDark ? "#E4E4E7" : "#0F172A";
  const gridColor = isDark ? "#2E2E34" : "#E2E8F0";

  const labels = timeseries.map(pt => `${pt.second_offset}s`);
  const vuData = timeseries.map(pt => Number(pt.active_vus || 0));
  const tpsData = timeseries.map(pt => Number(pt.throughput_rps || 0));
  const p95Data = timeseries.map(pt => Number(pt.p95_latency_ms || 0));

  runTimeseriesChart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Active VUs (Concurrency)",
          data: vuData,
          borderColor: "#8B5CF6",
          backgroundColor: "rgba(139, 92, 246, 0.12)",
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          yAxisID: "yVus"
        },
        {
          label: "Throughput (req/s)",
          data: tpsData,
          borderColor: "#2563EB",
          borderWidth: 2,
          tension: 0.2,
          yAxisID: "yTps"
        },
        {
          label: "p95 Latency (ms)",
          data: p95Data,
          borderColor: "#C25E1A",
          borderWidth: 2,
          tension: 0.2,
          yAxisID: "yLatency"
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          labels: { color: textColor, font: { family: "JetBrains Mono", size: 11 } }
        },
        tooltip: {
          padding: 10,
          titleFont: { family: "JetBrains Mono" },
          bodyFont: { family: "JetBrains Mono" }
        }
      },
      scales: {
        x: {
          grid: { color: gridColor },
          ticks: { color: textColor, font: { family: "JetBrains Mono", size: 10 } }
        },
        yVus: {
          type: "linear",
          position: "left",
          title: { display: true, text: "Active VUs", color: textColor, font: { size: 10 } },
          grid: { color: gridColor },
          ticks: { color: textColor, font: { family: "JetBrains Mono", size: 10 } },
          min: 0
        },
        yTps: {
          type: "linear",
          position: "right",
          title: { display: true, text: "RPS", color: textColor, font: { size: 10 } },
          grid: { drawOnChartArea: false },
          ticks: { color: textColor, font: { family: "JetBrains Mono", size: 10 } },
          min: 0
        },
        yLatency: {
          type: "linear",
          position: "right",
          title: { display: true, text: "p95 (ms)", color: textColor, font: { size: 10 } },
          grid: { drawOnChartArea: false },
          ticks: { color: textColor, font: { family: "JetBrains Mono", size: 10 } },
          min: 0
        }
      }
    }
  });
}

function inspectRun(runId) {
  switchTab("analytics");
  const select = document.getElementById("analyticsRunSelect");
  if (select) {
    select.value = runId;
  }
  loadRunInspector(runId);
}

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
