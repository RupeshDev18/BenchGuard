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
  initSaasWorkspace();
  initSaasModals();
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
// 3. Navigation & Client-Side SPA Router
// -------------------------------------------------------------
const ROUTES = {
  "/": { tab: "overview", title: "Platform Overview", icon: "🏠", category: "Core Testing" },
  "/studio": { tab: "studio", title: "Test Studio (Load)", icon: "⚡", category: "Core Testing" },
  "/console": { tab: "console", title: "Live Console", icon: "🖥️", category: "Core Testing" },
  "/schedules": { tab: "schedules", title: "Cron Schedules", icon: "⏰", category: "Automation & Reliability" },
  "/alarms": { tab: "alarms", title: "Alarms & Webhooks", icon: "🚨", category: "Automation & Reliability" },
  "/reports/executive": { tab: "managementReport", title: "Executive SLA Report", icon: "📊", category: "Observability & Reports" },
  "/reports/allure": { tab: "allureReport", title: "Allure 2 Deep-Dive", icon: "🏆", category: "Observability & Reports" },
  "/history": { tab: "history", title: "Run History", icon: "📜", category: "Observability & Reports" },
  "/analytics": { tab: "analytics", title: "Fleet Analytics & Trends", icon: "📈", category: "Observability & Reports" },
  "/projects": { tab: "projects", title: "Projects & Starter Kits", icon: "📁", category: "Workspace & Governance" },
  "/team": { tab: "team", title: "Team Members & Roles", icon: "👥", category: "Workspace & Governance" },
  "/admin": { tab: "admin", title: "Superadmin Portal", icon: "🏢", category: "Workspace & Governance" }
};

const ROUTE_ALIASES = {
  "/overview": "/",
  "/reports": "/reports/executive",
  "/report": "/reports/executive",
  "/allure": "/reports/allure"
};

const TAB_TO_ROUTE = {
  "overview": "/",
  "studio": "/studio",
  "console": "/console",
  "schedules": "/schedules",
  "alarms": "/alarms",
  "managementReport": "/reports/executive",
  "allureReport": "/reports/allure",
  "history": "/history",
  "analytics": "/analytics",
  "projects": "/projects",
  "team": "/team",
  "admin": "/admin"
};

function getCurrentRoutePath() {
  const hash = window.location.hash;
  if (hash && hash.startsWith("#/")) {
    return hash.slice(1);
  }
  const path = window.location.pathname;
  if (path && path !== "") {
    return path;
  }
  return "/";
}

function getCurrentRoute() {
  let path = getCurrentRoutePath();
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (ROUTE_ALIASES[path]) path = ROUTE_ALIASES[path];
  return ROUTES[path] || ROUTES["/"];
}

function navigateTo(path, options = { replace: false, skipHistory: false }) {
  if (!path) path = "/";
  path = path.trim();
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (ROUTE_ALIASES[path]) path = ROUTE_ALIASES[path];

  const route = ROUTES[path] || ROUTES["/"];
  const targetPath = ROUTES[path] ? path : "/";

  if (!options.skipHistory) {
    try {
      if (options.replace) {
        window.history.replaceState({ path: targetPath }, "", targetPath);
      } else if (window.location.pathname !== targetPath) {
        window.history.pushState({ path: targetPath }, "", targetPath);
      }
    } catch (_) {
      window.location.hash = "#" + targetPath;
    }
  }

  document.title = `${route.title} | k6 & Allure Performance Studio`;
  updateBreadcrumbs(route);

  // Update Nav links
  document.querySelectorAll("[data-nav-route]").forEach(link => {
    if (link.getAttribute("data-nav-route") === targetPath) {
      link.classList.add("active");
    } else {
      link.classList.remove("active");
    }
  });

  // Backward compatibility with tab-btn
  document.querySelectorAll(".tab-btn").forEach(btn => {
    if (btn.dataset.tab === route.tab) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  // Switch visible section
  document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
  const targetContent = document.getElementById(`tab-${route.tab}`);
  if (targetContent) {
    targetContent.classList.add("active");
  }

  // Trigger page loaders
  onRouteEnter(route.tab);

  // Close mobile sidebar if open
  const sidebar = document.getElementById("appSidebar");
  if (sidebar && sidebar.classList.contains("mobile-open")) {
    sidebar.classList.remove("mobile-open");
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function switchTab(tabName) {
  const targetRoute = TAB_TO_ROUTE[tabName] || "/";
  navigateTo(targetRoute);
}

function onRouteEnter(tabName) {
  switch (tabName) {
    case "history":
      loadRunHistory();
      break;
    case "analytics":
      loadAnalytics();
      break;
    case "managementReport":
    case "allureReport":
      refreshIframes();
      break;
    case "studio":
      drawLoadCurve();
      break;
    case "schedules":
      loadSchedules();
      break;
    case "alarms":
      loadWebhooks();
      break;
    case "projects":
      loadProjectsForCurrentOrg();
      renderProjectsPageList();
      loadAvailableTemplates();
      break;
    case "team":
      loadTeamMembers();
      break;
    case "admin":
      loadSuperadminDashboard();
      break;
  }
}

function updateBreadcrumbs(route) {
  const orgEl = document.getElementById("bcOrg");
  const projEl = document.getElementById("bcProject");
  const pageEl = document.getElementById("bcPage");
  const iconEl = document.getElementById("bcIcon");

  if (orgEl) orgEl.textContent = authState.currentOrg ? authState.currentOrg.name : "Tenant Org";
  if (projEl) projEl.textContent = authState.currentProject ? authState.currentProject.name : "Default Project";
  if (pageEl) pageEl.textContent = route.title;
  if (iconEl) iconEl.textContent = route.icon;
}

function initTabs() {
  // Global click delegator for [data-nav-route]
  document.addEventListener("click", (e) => {
    const navItem = e.target.closest("[data-nav-route]");
    if (navItem) {
      e.preventDefault();
      const route = navItem.getAttribute("data-nav-route");
      navigateTo(route);
    }
  });

  // Browser Back/Forward navigation listener
  window.addEventListener("popstate", () => {
    const path = getCurrentRoutePath();
    navigateTo(path, { skipHistory: true });
  });

  window.addEventListener("hashchange", () => {
    const path = getCurrentRoutePath();
    navigateTo(path, { skipHistory: true });
  });

  // Sidebar Collapse Toggle
  const sidebar = document.getElementById("appSidebar");
  const toggleBtn = document.getElementById("sidebarToggleBtn");
  if (sidebar && toggleBtn) {
    const savedState = localStorage.getItem("k6_sidebar_collapsed");
    if (savedState === "true") {
      sidebar.classList.add("collapsed");
      toggleBtn.textContent = "▶";
    }

    toggleBtn.addEventListener("click", () => {
      sidebar.classList.toggle("collapsed");
      const isCollapsed = sidebar.classList.contains("collapsed");
      toggleBtn.textContent = isCollapsed ? "▶" : "◀";
      localStorage.setItem("k6_sidebar_collapsed", isCollapsed ? "true" : "false");
    });
  }

  // Mobile menu button toggle
  const mobileMenuBtn = document.getElementById("mobileMenuBtn");
  if (mobileMenuBtn && sidebar) {
    mobileMenuBtn.addEventListener("click", () => {
      sidebar.classList.toggle("mobile-open");
    });
  }

  // Quick Run CTAs (Sidebar & Topbar)
  const handleQuickRunAction = () => {
    navigateTo("/studio");
    setTimeout(() => {
      const launchBtn = document.getElementById("launchTestBtn");
      if (launchBtn) {
        launchBtn.scrollIntoView({ behavior: "smooth", block: "center" });
        launchBtn.focus();
      }
    }, 150);
  };

  const sidebarQuickRunBtn = document.getElementById("sidebarQuickRunBtn");
  if (sidebarQuickRunBtn) {
    sidebarQuickRunBtn.addEventListener("click", handleQuickRunAction);
  }

  const headerQuickRunBtn = document.getElementById("headerQuickRunBtn");
  if (headerQuickRunBtn) {
    headerQuickRunBtn.addEventListener("click", handleQuickRunAction);
  }

  const goToRealStudioBtn = document.getElementById("goToRealStudioBtn");
  if (goToRealStudioBtn) {
    goToRealStudioBtn.addEventListener("click", () => navigateTo("/studio"));
  }

  const landingQuickDemoBtn = document.getElementById("landingQuickDemoBtn");
  if (landingQuickDemoBtn) {
    landingQuickDemoBtn.addEventListener("click", () => {
      const runDemoBtn = document.getElementById("runDemoBenchmarkBtn");
      if (runDemoBtn) runDemoBtn.click();
    });
  }

  // Initial Route dispatch based on current URL path or hash
  const initialPath = getCurrentRoutePath();
  navigateTo(initialPath, { replace: true });
}


async function refreshIframes() {
  const mgmtIframe = document.getElementById("managementReportIframe");
  const allureIframe = document.getElementById("allureReportIframe");
  
  let mgmtUrl = "/reports/report.html";
  let allureUrl = "/reports/allure-report/index.html";

  if (authState.currentProject) {
    try {
      const statusRes = await fetch(`/api/projects/${authState.currentProject.id}/reports/status`, { headers: getAuthHeaders() });
      if (statusRes.ok) {
        const s = await statusRes.json();
        if (s.hasManagementReport) mgmtUrl = s.managementReportUrl;
        if (s.hasAllureReport) allureUrl = s.allureReportUrl;
      }
    } catch (e) {}
  }

  if (mgmtIframe) mgmtIframe.src = `${mgmtUrl}?t=${Date.now()}`;
  if (allureIframe) allureIframe.src = `${allureUrl}?t=${Date.now()}`;
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

  // Circuit Breaker (Stop on Failure)
  const cbCheckbox = document.getElementById("circuitBreakerEnabled");
  const maxFailuresInput = document.getElementById("maxFailuresToStopInput");
  const stopFailuresVal = cfg.thresholds?.maxFailuresToStop || cfg.maxFailuresToStop;
  if (cbCheckbox && maxFailuresInput) {
    if (stopFailuresVal && Number(stopFailuresVal) > 0) {
      cbCheckbox.checked = true;
      maxFailuresInput.value = stopFailuresVal;
    } else {
      cbCheckbox.checked = false;
      maxFailuresInput.value = 10;
    }
  }

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

  // Distributed Load Generator Fleet
  const workers = parseInt(cfg.workersCount || 1, 10);
  document.querySelectorAll("#workerCountSelector .pill-option").forEach((btn) => {
    if (parseInt(btn.dataset.workers, 10) === workers) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
  updateWorkerSelectorNote(workers);

  drawLoadCurve();
}

function updateWorkerSelectorNote(workers) {
  const noteEl = document.getElementById("workerDistributionNote");
  const badgeEl = document.getElementById("distributedWorkerInfoBadge");
  if (!noteEl || !badgeEl) return;

  const w = parseInt(workers || 1, 10);
  if (w <= 1) {
    badgeEl.textContent = "1 Worker (Local Engine)";
    badgeEl.className = "badge badge-primary";
    noteEl.textContent = "Execution: 100% of VUs executed on Worker #1 (Segment: 0:1).";
  } else {
    badgeEl.textContent = `${w} Workers Distributed`;
    badgeEl.className = "badge badge-success";
    const slicePct = (100 / w).toFixed(1);
    noteEl.textContent = `Partition: ${w} worker nodes in parallel (~${slicePct}% VUs per worker segment).`;
  }
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
  const landingBadge = document.getElementById("landingMockBadge");
  const toggleBtn = document.getElementById("demoToggleMockBtn");
  const title = document.getElementById("demoMockStatusTitle");

  if (landingBadge) {
    landingBadge.className = isRunning ? "badge badge-success" : "badge";
    landingBadge.textContent = isRunning ? "Mock API Active (Port 8080)" : "Mock API Inactive";
  }

  if (badge) {
    badge.className = isRunning ? "badge badge-success" : "badge";
    badge.textContent = isRunning ? "Running (Port 8080)" : "Stopped";
  }
  if (toggleBtn) {
    toggleBtn.className = isRunning ? "btn btn-danger btn-sm" : "btn btn-secondary btn-sm";
    toggleBtn.textContent = isRunning ? "Stop Mock Server" : "Start Mock Server";
  }
  if (title) {
    title.textContent = isRunning ? "Spring Boot Mock Running" : "Mock Server Stopped";
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

  // Distributed Load Generator Fleet Selector
  document.querySelectorAll("#workerCountSelector .pill-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#workerCountSelector .pill-option").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const count = parseInt(btn.dataset.workers, 10) || 1;
      updateWorkerSelectorNote(count);
      drawLoadCurve();
    });
  });

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

  const cbEnabled = document.getElementById("circuitBreakerEnabled")?.checked;
  const maxFailures = parseInt(document.getElementById("maxFailuresToStopInput")?.value, 10);
  if (cbEnabled && maxFailures > 0) {
    cfg.thresholds.maxFailuresToStop = maxFailures;
    cfg.maxFailuresToStop = maxFailures;
  } else {
    delete cfg.thresholds.maxFailuresToStop;
    delete cfg.maxFailuresToStop;
  }

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

  // Distributed Load Generator Fleet
  const activeWorkerBtn = document.querySelector("#workerCountSelector .pill-option.active");
  const workersCount = activeWorkerBtn ? parseInt(activeWorkerBtn.dataset.workers, 10) : 1;
  cfg.workersCount = workersCount || 1;

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
    const projId = authState.currentProject?.id;
    const url = projId ? `/api/projects/${projId}/pipeline/start` : `/api/pipeline/start`;
    const res = await fetch(url, {
      method: "POST",
      headers: getAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        ...cfg,
        workersCount: cfg.workersCount || 1,
        maxFailuresToStop: cfg.thresholds?.maxFailuresToStop || null,
        projectId: projId,
        orgId: authState.currentOrg?.id
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed starting pipeline");
    showToast(`Load test execution started for ${authState.currentProject?.name || 'project'}!`, "info", "Pipeline");
  } catch (err) {
    showToast("Execution error: " + err.message, "error");
  }
}

async function abortTest() {
  if (confirm("Abort the active load test pipeline immediately?")) {
    try {
      const projId = authState.currentProject?.id;
      const url = projId ? `/api/projects/${projId}/pipeline/stop` : `/api/pipeline/stop`;
      await fetch(url, { method: "POST", headers: getAuthHeaders() });
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
    const projId = authState.currentProject?.id;
    const url = projId ? `/api/projects/${projId}/runs` : `/api/runs`;
    const res = await fetch(url, { headers: getAuthHeaders() });
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
    const projId = authState.currentProject?.id;
    const trendsUrl = projId
      ? `/api/projects/${projId}/analytics/trends?env=${encodeURIComponent(env)}`
      : `/api/analytics/trends?env=${encodeURIComponent(env)}`;
    const runsUrl = projId
      ? `/api/projects/${projId}/runs?env=${encodeURIComponent(env)}&limit=50`
      : `/api/runs?env=${encodeURIComponent(env)}&limit=50`;

    const [trendsRes, runsRes] = await Promise.all([
      fetch(trendsUrl, { headers: getAuthHeaders() }),
      fetch(runsUrl, { headers: getAuthHeaders() })
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

// ==========================================================================
// Phase 3: SaaS Multi-Tenant Front-End Engine
// Organization Switcher • Project Scopes • Team RBAC • Superadmin Portal
// ==========================================================================

const authState = {
  token: localStorage.getItem("k6_saas_token") || "",
  user: JSON.parse(localStorage.getItem("k6_saas_user") || "null"),
  organizations: [],
  currentOrg: null,
  projects: [],
  currentProject: null,
  availableTemplates: []
};

function getAuthHeaders(customHeaders = {}) {
  const headers = { ...customHeaders };
  if (authState.token) {
    headers["Authorization"] = `Bearer ${authState.token}`;
  }
  if (authState.currentOrg) {
    headers["X-Org-Id"] = authState.currentOrg.id;
  }
  return headers;
}

function openModal(modalId) {
  if (modalId === "newProjectModal") {
    navigateTo("/projects");
    return;
  }
  if (modalId === "teamModal") {
    navigateTo("/team");
    return;
  }
  if (modalId === "superadminModal") {
    navigateTo("/admin");
    return;
  }
  if (modalId === "schedulesModal") {
    navigateTo("/schedules");
    return;
  }
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove("hidden");
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add("hidden");
  }
}

async function initSaasWorkspace() {
  try {
    // 1. If no token, auto-login with default seeded Superadmin account
    if (!authState.token || !authState.user) {
      await performLogin("superadmin@platform.local", "Admin@12345", false);
    } else {
      // Validate existing token
      const meRes = await fetch("/api/auth/me", { headers: getAuthHeaders() });
      if (!meRes.ok) {
        console.warn("[SaaS] Saved token expired. Re-authenticating default superadmin...");
        await performLogin("superadmin@platform.local", "Admin@12345", false);
      } else {
        const meData = await meRes.json();
        authState.user = meData.user;
        authState.organizations = meData.organizations || [];
        updateUserSessionUi();
        populateOrganizationsDropdown();
      }
    }
  } catch (err) {
    console.error("[SaaS] Workspace initialization error:", err);
  }
}

async function performLogin(email, password, showFeedback = true) {
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Authentication failed");
    }

    authState.token = data.token;
    authState.user = data.user;
    authState.organizations = data.organizations || [];

    localStorage.setItem("k6_saas_token", data.token);
    localStorage.setItem("k6_saas_user", JSON.stringify(data.user));

    updateUserSessionUi();
    await populateOrganizationsDropdown();

    if (showFeedback) {
      showToast(`Authenticated as ${data.user.fullName} (${data.user.email})`, "success", "Welcome");
    }
  } catch (err) {
    if (showFeedback) {
      showToast(err.message, "error", "Sign In Failed");
    }
    throw err;
  }
}

function updateUserSessionUi() {
  const user = authState.user;
  const nameEl = document.getElementById("userFullNameText");
  const roleEl = document.getElementById("userRoleBadge");
  const avatarEl = document.getElementById("userAvatar");
  const superadminBtn = document.getElementById("openSuperadminBtn");
  const sidebarAdminLink = document.getElementById("sidebarAdminLink");

  if (user) {
    if (nameEl) nameEl.textContent = user.fullName || user.email;
    if (roleEl) roleEl.textContent = user.isSuperadmin ? "Platform Owner" : "Org Member";
    if (avatarEl) {
      const initial = (user.fullName || user.email || "U")[0].toUpperCase();
      avatarEl.textContent = initial;
    }
    if (user.isSuperadmin) {
      if (superadminBtn) superadminBtn.classList.remove("hidden");
      if (sidebarAdminLink) sidebarAdminLink.classList.remove("hidden");
    } else {
      if (superadminBtn) superadminBtn.classList.add("hidden");
      if (sidebarAdminLink) sidebarAdminLink.classList.add("hidden");
    }
  }
}

async function populateOrganizationsDropdown() {
  const orgSelect = document.getElementById("headerOrgSelect");
  if (!orgSelect) return;

  orgSelect.innerHTML = "";
  if (!authState.organizations || authState.organizations.length === 0) {
    orgSelect.innerHTML = `<option value="">No Organizations Found</option>`;
    return;
  }

  authState.organizations.forEach((org, idx) => {
    const opt = document.createElement("option");
    opt.value = org.id;
    opt.textContent = `${org.name} (${org.plan_tier ? org.plan_tier.toUpperCase() : 'STARTER'})`;
    orgSelect.appendChild(opt);
  });

  // Pick first or previously selected org
  const savedOrgId = localStorage.getItem("k6_selected_org_id");
  const matching = authState.organizations.find(o => o.id === savedOrgId);
  const selectedOrg = matching || authState.organizations[0];

  orgSelect.value = selectedOrg.id;
  authState.currentOrg = selectedOrg;
  localStorage.setItem("k6_selected_org_id", selectedOrg.id);

  // Update Plan Badge in header
  const planBadge = document.getElementById("activePlanBadge");
  if (planBadge && selectedOrg.plan_tier) {
    planBadge.textContent = selectedOrg.plan_tier.toUpperCase();
    planBadge.className = `brand-badge plan-${selectedOrg.plan_tier}`;
  }

  // Load projects for this organization
  await loadProjectsForCurrentOrg();
}

async function loadProjectsForCurrentOrg() {
  if (!authState.currentOrg) return;

  const projectSelect = document.getElementById("headerProjectSelect");
  if (!projectSelect) return;

  try {
    const res = await fetch(`/api/orgs/${authState.currentOrg.id}/projects`, {
      headers: getAuthHeaders()
    });

    if (!res.ok) {
      projectSelect.innerHTML = `<option value="">Failed to load projects</option>`;
      return;
    }

    const projects = await res.json();
    authState.projects = Array.isArray(projects) ? projects : [];

    projectSelect.innerHTML = "";
    if (authState.projects.length === 0) {
      projectSelect.innerHTML = `<option value="">+ Create your first project</option>`;
      authState.currentProject = null;
      loadRunHistory();
      loadAnalytics();
      return;
    }

    authState.projects.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      projectSelect.appendChild(opt);
    });

    const savedProjectId = localStorage.getItem(`k6_selected_project_${authState.currentOrg.id}`);
    const matchingProj = authState.projects.find(p => p.id === savedProjectId);
    const selectedProj = matchingProj || authState.projects[0];

    projectSelect.value = selectedProj.id;
    authState.currentProject = selectedProj;
    localStorage.setItem(`k6_selected_project_${authState.currentOrg.id}`, selectedProj.id);

    // Refresh scoped views
    await onProjectChanged(selectedProj);
    renderProjectsPageList();
    updateBreadcrumbs(getCurrentRoute());
  } catch (err) {
    console.error("[SaaS] Error loading projects for org:", err);
  }
}

function renderProjectsPageList() {
  const container = document.getElementById("projectsPageCards");
  const countBadge = document.getElementById("projectsCountBadge");
  const tenantBadge = document.getElementById("projectsTenantBadge");

  if (tenantBadge && authState.currentOrg) {
    tenantBadge.textContent = `${authState.currentOrg.name} (${(authState.currentOrg.plan_tier || 'STARTER').toUpperCase()})`;
  }

  if (!container) return;

  if (!authState.projects || authState.projects.length === 0) {
    if (countBadge) countBadge.textContent = "0 Projects";
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 36px 20px; background: var(--surface); border: 1px dashed var(--border); border-radius: var(--radius);">
        <div style="font-size: 32px; margin-bottom: 10px;">📁</div>
        <div style="font-weight: 700; font-size: 15px; margin-bottom: 6px; color: var(--text);">No Projects in this Organization Yet</div>
        <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 16px;">Create your first testing project below or initialize from a production starter kit.</div>
        <a href="#newProjectSection" class="btn btn-primary btn-sm">+ Create First Project</a>
      </div>
    `;
    return;
  }

  if (countBadge) countBadge.textContent = `${authState.projects.length} Project${authState.projects.length === 1 ? '' : 's'}`;

  container.innerHTML = "";
  authState.projects.forEach(p => {
    const isCurrent = authState.currentProject && authState.currentProject.id === p.id;
    const card = document.createElement("div");
    card.className = `project-card-item ${isCurrent ? 'is-current' : ''}`;
    
    card.innerHTML = `
      <div class="project-card-meta">
        <div class="project-card-name">${escapeHtml(p.name)}</div>
        <div class="project-card-slug">${escapeHtml(p.slug || p.id)}</div>
        <div class="project-card-desc">${escapeHtml(p.description || "OpenAPI test suite with automated SLA benchmarks.")}</div>
      </div>
      <div class="project-card-stats">
        <span>Target: <strong>${escapeHtml(p.base_url || 'http://localhost:8080')}</strong></span>
      </div>
      <div class="project-card-footer">
        ${isCurrent 
          ? `<span class="badge badge-success" style="font-size: 11px;">✓ Active Project</span>`
          : `<button class="btn btn-sm btn-dark switch-proj-btn" data-id="${p.id}" type="button">Switch to This</button>`
        }
        <button class="btn btn-sm btn-primary open-studio-proj-btn" data-id="${p.id}" type="button">⚡ Studio</button>
      </div>
    `;
    container.appendChild(card);
  });

  container.querySelectorAll(".switch-proj-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const projId = btn.dataset.id;
      const targetProj = authState.projects.find(p => p.id === projId);
      if (targetProj) {
        const sel = document.getElementById("headerProjectSelect");
        if (sel) sel.value = targetProj.id;
        authState.currentProject = targetProj;
        localStorage.setItem(`k6_selected_project_${authState.currentOrg.id}`, targetProj.id);
        await onProjectChanged(targetProj);
        renderProjectsPageList();
        updateBreadcrumbs(getCurrentRoute());
        showToast(`Switched active project to ${targetProj.name}`, "info");
      }
    });
  });

  container.querySelectorAll(".open-studio-proj-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const projId = btn.dataset.id;
      const targetProj = authState.projects.find(p => p.id === projId);
      if (targetProj) {
        const sel = document.getElementById("headerProjectSelect");
        if (sel) sel.value = targetProj.id;
        authState.currentProject = targetProj;
        localStorage.setItem(`k6_selected_project_${authState.currentOrg.id}`, targetProj.id);
        await onProjectChanged(targetProj);
        navigateTo("/studio");
      }
    });
  });
}

async function onProjectChanged(project) {
  try {
    const res = await fetch(`/api/projects/${project.id}`, { headers: getAuthHeaders() });
    if (res.ok) {
      const data = await res.json();
      
      // Update Environment Selector if project defines environments
      if (data.environments && data.environments.length > 0) {
        const targetEnvSelect = document.getElementById("targetEnvironmentSelect");
        if (targetEnvSelect) {
          targetEnvSelect.innerHTML = "";
          data.environments.forEach(e => {
            const opt = document.createElement("option");
            opt.value = e.name;
            opt.textContent = `${e.name.toUpperCase()} (${e.base_url})`;
            targetEnvSelect.appendChild(opt);
          });
        }
      }
    }

    // Refresh history and analytics filtered to this project
    loadRunHistory();
    loadAnalytics();
  } catch (err) {
    console.error("[SaaS] Error switching project:", err);
  }
}

function initSaasModals() {
  // 1. Organization & Project Switchers
  const orgSelect = document.getElementById("headerOrgSelect");
  if (orgSelect) {
    orgSelect.addEventListener("change", async (e) => {
      const chosenOrg = authState.organizations.find(o => o.id === e.target.value);
      if (chosenOrg) {
        authState.currentOrg = chosenOrg;
        localStorage.setItem("k6_selected_org_id", chosenOrg.id);
        showToast(`Switched organization to ${chosenOrg.name}`, "info", "Tenant Switcher");
        await loadProjectsForCurrentOrg();
      }
    });
  }

  const projectSelect = document.getElementById("headerProjectSelect");
  if (projectSelect) {
    projectSelect.addEventListener("change", async (e) => {
      const chosenProj = authState.projects.find(p => p.id === e.target.value);
      if (chosenProj) {
        authState.currentProject = chosenProj;
        localStorage.setItem(`k6_selected_project_${authState.currentOrg.id}`, chosenProj.id);
        showToast(`Switched active project to ${chosenProj.name}`, "info", "Project Scope");
        await onProjectChanged(chosenProj);
      }
    });
  }

  // 2. New Project Modal
  const openNewProjectBtn = document.getElementById("openNewProjectBtn");
  if (openNewProjectBtn) {
    openNewProjectBtn.addEventListener("click", async () => {
      openModal("newProjectModal");
      await loadAvailableTemplates();
    });
  }

  const closeNewProjectBtn = document.getElementById("closeNewProjectModalBtn");
  if (closeNewProjectBtn) closeNewProjectBtn.addEventListener("click", () => closeModal("newProjectModal"));
  const cancelNewProjectBtn = document.getElementById("cancelNewProjectBtn");
  if (cancelNewProjectBtn) cancelNewProjectBtn.addEventListener("click", () => closeModal("newProjectModal"));

  // Auto-slugify project name
  const nameInput = document.getElementById("newProjectName");
  const slugInput = document.getElementById("newProjectSlug");
  if (nameInput && slugInput) {
    nameInput.addEventListener("input", (e) => {
      slugInput.value = e.target.value
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    });
  }

  // Template cards selection
  document.querySelectorAll("#templateCardsGrid .template-card").forEach(card => {
    card.addEventListener("click", () => {
      document.querySelectorAll("#templateCardsGrid .template-card").forEach(c => c.classList.remove("active"));
      card.classList.add("active");
    });
  });

  const submitNewProjectBtn = document.getElementById("submitNewProjectBtn");
  if (submitNewProjectBtn) {
    submitNewProjectBtn.addEventListener("click", async () => {
      if (!authState.currentOrg) {
        return showToast("Please select a tenant organization first.", "error");
      }

      const name = nameInput.value.trim();
      const slug = slugInput.value.trim();
      const description = document.getElementById("newProjectDesc")?.value.trim() || "";
      const activeCard = document.querySelector("#templateCardsGrid .template-card.active");
      const templateId = activeCard ? activeCard.dataset.templateId : "minimal-rest-api";

      if (!name || !slug) {
        return showToast("Project Name and Slug are required.", "warning");
      }

      submitNewProjectBtn.disabled = true;
      submitNewProjectBtn.textContent = "Creating...";

      try {
        const res = await fetch(`/api/orgs/${authState.currentOrg.id}/projects`, {
          method: "POST",
          headers: getAuthHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ name, slug, description, templateId })
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Failed to create project");
        }

        showToast(`Project '${name}' provisioned successfully!`, "success", "Project Ready");
        closeModal("newProjectModal");
        nameInput.value = "";
        slugInput.value = "";

        // Reload projects and switch to newly created one
        await loadProjectsForCurrentOrg();
        const projectSelect = document.getElementById("headerProjectSelect");
        if (projectSelect && data.project) {
          projectSelect.value = data.project.id;
          authState.currentProject = data.project;
          await onProjectChanged(data.project);
        }
      } catch (err) {
        showToast(err.message, "error", "Project Creation Failed");
      } finally {
        submitNewProjectBtn.disabled = false;
        submitNewProjectBtn.textContent = "⚡ Create Project";
      }
    });
  }

  // 3. Superadmin Modal
  const openSuperadminBtn = document.getElementById("openSuperadminBtn");
  if (openSuperadminBtn) {
    openSuperadminBtn.addEventListener("click", async () => {
      openModal("superadminModal");
      await loadSuperadminDashboard();
    });
  }

  const closeSuperadminModalBtn = document.getElementById("closeSuperadminModalBtn");
  if (closeSuperadminModalBtn) closeSuperadminModalBtn.addEventListener("click", () => closeModal("superadminModal"));
  const closeSuperadminPortalBtn = document.getElementById("closeSuperadminPortalBtn");
  if (closeSuperadminPortalBtn) closeSuperadminPortalBtn.addEventListener("click", () => closeModal("superadminModal"));

  // Admin sub-tabs
  document.querySelectorAll("[data-admin-tab]").forEach(tabBtn => {
    tabBtn.addEventListener("click", () => {
      document.querySelectorAll("[data-admin-tab]").forEach(b => b.classList.remove("active"));
      tabBtn.classList.add("active");

      const tab = tabBtn.dataset.adminTab;
      const overviewPanel = document.getElementById("adminTabOverview");
      const onboardPanel = document.getElementById("adminTabOnboard");
      const submitBtn = document.getElementById("submitOnboardOrgBtn");

      if (tab === "overview") {
        overviewPanel.classList.remove("hidden");
        onboardPanel.classList.add("hidden");
        submitBtn.classList.add("hidden");
        loadSuperadminDashboard();
      } else {
        overviewPanel.classList.add("hidden");
        onboardPanel.classList.remove("hidden");
        submitBtn.classList.remove("hidden");
      }
    });
  });

  // Onboard Org auto-slugify
  const onboardOrgName = document.getElementById("onboardOrgName");
  const onboardOrgSlug = document.getElementById("onboardOrgSlug");
  if (onboardOrgName && onboardOrgSlug) {
    onboardOrgName.addEventListener("input", (e) => {
      onboardOrgSlug.value = e.target.value
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    });
  }

  const submitOnboardOrgBtn = document.getElementById("submitOnboardOrgBtn");
  if (submitOnboardOrgBtn) {
    submitOnboardOrgBtn.addEventListener("click", async () => {
      const orgName = onboardOrgName.value.trim();
      const orgSlug = onboardOrgSlug.value.trim();
      const planTier = document.getElementById("onboardPlanTier").value;
      const maxVusAllowed = parseInt(document.getElementById("onboardMaxVus").value, 10);
      const maxProjects = parseInt(document.getElementById("onboardMaxProjects").value, 10);
      const adminFullName = document.getElementById("onboardAdminName").value.trim();
      const adminEmail = document.getElementById("onboardAdminEmail").value.trim();
      const adminPassword = document.getElementById("onboardAdminPassword").value;

      if (!orgName || !orgSlug || !adminEmail || !adminPassword) {
        return showToast("Organization Name, Slug, Admin Email and Password are required.", "warning");
      }

      submitOnboardOrgBtn.disabled = true;
      submitOnboardOrgBtn.textContent = "Provisioning...";

      try {
        const res = await fetch("/api/admin/organizations", {
          method: "POST",
          headers: getAuthHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            orgName, orgSlug, planTier, maxVusAllowed, maxProjects,
            adminFullName, adminEmail, adminPassword, createStarterProject: true
          })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Onboarding failed");

        showToast(`Tenant '${orgName}' onboarded with Admin '${adminEmail}'!`, "success", "Tenant Ready");
        
        // Reset inputs and return to overview
        onboardOrgName.value = "";
        onboardOrgSlug.value = "";
        document.getElementById("onboardAdminEmail").value = "";

        const overviewTab = document.querySelector("[data-admin-tab='overview']");
        if (overviewTab) overviewTab.click();

        // Refresh global orgs list
        const meRes = await fetch("/api/auth/me", { headers: getAuthHeaders() });
        if (meRes.ok) {
          const meData = await meRes.json();
          authState.organizations = meData.organizations || [];
          populateOrganizationsDropdown();
        }
      } catch (err) {
        showToast(err.message, "error", "Onboarding Failed");
      } finally {
        submitOnboardOrgBtn.disabled = false;
        submitOnboardOrgBtn.textContent = "🚀 Provision Organization";
      }
    });
  }

  // 4. Team Modal
  const openTeamBtn = document.getElementById("openTeamBtn");
  if (openTeamBtn) {
    openTeamBtn.addEventListener("click", async () => {
      openModal("teamModal");
      await loadTeamMembers();
    });
  }

  const closeTeamModalBtn = document.getElementById("closeTeamModalBtn");
  if (closeTeamModalBtn) closeTeamModalBtn.addEventListener("click", () => closeModal("teamModal"));
  const closeTeamModalFooterBtn = document.getElementById("closeTeamModalFooterBtn");
  if (closeTeamModalFooterBtn) closeTeamModalFooterBtn.addEventListener("click", () => closeModal("teamModal"));

  const submitAddMemberBtn = document.getElementById("submitAddMemberBtn");
  if (submitAddMemberBtn) {
    submitAddMemberBtn.addEventListener("click", async () => {
      if (!authState.currentOrg) return;

      const fullName = document.getElementById("newMemberName").value.trim();
      const email = document.getElementById("newMemberEmail").value.trim();
      const password = document.getElementById("newMemberPassword").value;
      const role = document.getElementById("newMemberRole").value;

      if (!email || !password) {
        return showToast("Member Email and Password are required.", "warning");
      }

      submitAddMemberBtn.disabled = true;
      try {
        const res = await fetch(`/api/orgs/${authState.currentOrg.id}/members`, {
          method: "POST",
          headers: getAuthHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ fullName, email, password, role })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to add member");

        showToast(`Added ${fullName || email} as ${role.toUpperCase()}`, "success", "Member Invited");
        document.getElementById("newMemberName").value = "";
        document.getElementById("newMemberEmail").value = "";
        await loadTeamMembers();
      } catch (err) {
        showToast(err.message, "error", "Member Addition Failed");
      } finally {
        submitAddMemberBtn.disabled = false;
      }
    });
  }

  // 5. Auth / Session Switcher Modal
  const userSessionChip = document.getElementById("userSessionChip");
  if (userSessionChip) {
    userSessionChip.addEventListener("click", () => {
      openModal("authModal");
    });
  }

  const closeAuthModalBtn = document.getElementById("closeAuthModalBtn");
  if (closeAuthModalBtn) closeAuthModalBtn.addEventListener("click", () => closeModal("authModal"));

  const quickLoginSuperadminBtn = document.getElementById("quickLoginSuperadminBtn");
  if (quickLoginSuperadminBtn) {
    quickLoginSuperadminBtn.addEventListener("click", async () => {
      try {
        await performLogin("superadmin@platform.local", "Admin@12345", true);
        closeModal("authModal");
      } catch (err) {
        // handled in performLogin
      }
    });
  }

  const submitCustomLoginBtn = document.getElementById("submitCustomLoginBtn");
  if (submitCustomLoginBtn) {
    submitCustomLoginBtn.addEventListener("click", async () => {
      const email = document.getElementById("loginEmailInput")?.value.trim();
      const password = document.getElementById("loginPasswordInput")?.value;
      if (!email || !password) {
        return showToast("Please enter both email and password", "warning");
      }
      try {
        await performLogin(email, password, true);
        closeModal("authModal");
      } catch (err) {
        // handled in performLogin
      }
    });
  }

  // Close modals when clicking backdrop
  document.querySelectorAll(".modal-overlay").forEach(overlay => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        overlay.classList.add("hidden");
      }
    });
  });

  // 6. Schedules & Webhooks Modal
  initSchedulesAndWebhooksUI();
}

async function loadAvailableTemplates() {
  try {
    const res = await fetch("/api/orgs/templates/list", { headers: getAuthHeaders() });
    if (res.ok) {
      const templates = await res.json();
      authState.availableTemplates = templates;
    }
  } catch (err) {
    console.warn("Could not load templates:", err);
  }
}

async function loadSuperadminDashboard() {
  try {
    const [overviewRes, orgsRes] = await Promise.all([
      fetch("/api/admin/overview", { headers: getAuthHeaders() }),
      fetch("/api/admin/organizations", { headers: getAuthHeaders() })
    ]);

    if (overviewRes.ok) {
      const data = await overviewRes.json();
      const m = data.metrics || {};
      const elOrgs = document.getElementById("adminTotalOrgs");
      const elUsers = document.getElementById("adminTotalUsers");
      const elProj = document.getElementById("adminTotalProjects");
      const elRuns = document.getElementById("adminTotalRuns");

      if (elOrgs) elOrgs.textContent = m.totalOrganizations || 0;
      if (elUsers) elUsers.textContent = m.totalUsers || 0;
      if (elProj) elProj.textContent = m.totalProjects || 0;
      if (elRuns) elRuns.textContent = m.totalTestRuns || 0;
    }

    if (orgsRes.ok) {
      const orgs = await orgsRes.json();
      const tbody = document.getElementById("adminOrgsTableBody");
      if (tbody) {
        tbody.innerHTML = "";
        orgs.forEach(o => {
          const tr = document.createElement("tr");
          const createdStr = o.created_at ? new Date(o.created_at).toLocaleDateString() : "-";
          tr.innerHTML = `
            <td>
              <div style="font-weight: 700; color: var(--text);">${escapeHtml(o.name)}</div>
              <div style="font-size: 11px; font-family: var(--font-mono); color: var(--text-muted);">${escapeHtml(o.slug)}</div>
            </td>
            <td><span class="plan-badge plan-${o.plan_tier}">${escapeHtml(o.plan_tier)}</span></td>
            <td style="font-family: var(--font-mono); font-weight: 600;">${o.max_vus_allowed || 100} VUs</td>
            <td style="font-family: var(--font-mono);">${o.project_count || 0} / ${o.max_projects || 10}</td>
            <td style="font-family: var(--font-mono);">${o.member_count || 0}</td>
            <td style="font-family: var(--font-mono); font-weight: 700;">${o.run_count || 0}</td>
            <td style="font-size: 11px; color: var(--text-muted);">${createdStr}</td>
          `;
          tbody.appendChild(tr);
        });
      }
    }
  } catch (err) {
    console.error("Superadmin dashboard error:", err);
  }
}

async function loadTeamMembers() {
  if (!authState.currentOrg) return;

  const orgNameEl = document.getElementById("teamOrgName");
  const orgPlanEl = document.getElementById("teamOrgPlan");
  const planBadgeEl = document.getElementById("teamPlanBadge");
  const tbody = document.getElementById("teamMembersTableBody");

  if (orgNameEl) orgNameEl.textContent = authState.currentOrg.name;
  if (orgPlanEl) orgPlanEl.textContent = `Plan: ${(authState.currentOrg.plan_tier || 'team').toUpperCase()} • Quota: ${authState.currentOrg.max_vus_allowed || 200} VUs`;
  if (planBadgeEl) {
    planBadgeEl.textContent = (authState.currentOrg.plan_tier || 'team').toUpperCase();
    planBadgeEl.className = `plan-badge plan-${authState.currentOrg.plan_tier || 'team'}`;
  }

  try {
    const res = await fetch(`/api/orgs/${authState.currentOrg.id}/members`, { headers: getAuthHeaders() });
    if (!res.ok) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 15px;">Unable to fetch team members.</td></tr>`;
      return;
    }

    const members = await res.json();
    if (tbody) {
      tbody.innerHTML = "";
      if (members.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 15px;">No other members in this organization.</td></tr>`;
      } else {
        members.forEach(m => {
          const tr = document.createElement("tr");
          tr.innerHTML = `
            <td style="font-weight: 600; color: var(--text);">${escapeHtml(m.full_name || m.email)}</td>
            <td style="font-family: var(--font-mono); font-size: 12px; color: var(--text-muted);">${escapeHtml(m.email)}</td>
            <td><span class="role-pill role-${m.role}">${escapeHtml(m.role)}</span></td>
          `;
          tbody.appendChild(tr);
        });
      }
    }
  } catch (err) {
    console.error("Team members fetch error:", err);
  }
}

// ============================================================================
// SAAS CONTROLLER: AUTOMATED BENCHMARK SCHEDULES & ALERT WEBHOOKS
// ============================================================================

function initSchedulesAndWebhooksUI() {
  const openBtn = document.getElementById("openSchedulesBtn");
  const modal = document.getElementById("schedulesModal");
  const closeBtn = document.getElementById("closeSchedulesModalBtn");
  const closeFooterBtn = document.getElementById("closeSchedulesModalFooterBtn");

  const tabSchedules = document.getElementById("schSubTabSchedules");
  const tabWebhooks = document.getElementById("schSubTabWebhooks");
  const panelSchedules = document.getElementById("schPanelSchedules");
  const panelWebhooks = document.getElementById("schPanelWebhooks");

  const presetSelect = document.getElementById("newSchPreset");
  const cronInput = document.getElementById("newSchCron");
  const submitScheduleBtn = document.getElementById("submitCreateScheduleBtn");

  const submitWebhookBtn = document.getElementById("submitCreateWebhookBtn");
  const testWebhookBtn = document.getElementById("testWebhookBtn");

  if (!openBtn || !modal) return;

  openBtn.addEventListener("click", () => {
    openModal("schedulesModal");
    const projNameEl = document.getElementById("schedulesModalProjectName");
    if (projNameEl) {
      projNameEl.textContent = authState.currentProject ? authState.currentProject.name : "No Project Selected";
    }
    loadSchedules();
    loadWebhooks();
  });

  if (closeBtn) closeBtn.addEventListener("click", () => closeModal("schedulesModal"));
  if (closeFooterBtn) closeFooterBtn.addEventListener("click", () => closeModal("schedulesModal"));

  // Tab switching
  if (tabSchedules && tabWebhooks && panelSchedules && panelWebhooks) {
    tabSchedules.addEventListener("click", () => {
      tabSchedules.className = "btn btn-sm btn-primary";
      tabWebhooks.className = "btn btn-sm btn-dark";
      panelSchedules.classList.remove("hidden");
      panelWebhooks.classList.add("hidden");
    });

    tabWebhooks.addEventListener("click", () => {
      tabWebhooks.className = "btn btn-sm btn-primary";
      tabSchedules.className = "btn btn-sm btn-dark";
      panelWebhooks.classList.remove("hidden");
      panelSchedules.classList.add("hidden");
    });
  }

  // Frequency preset change
  if (presetSelect && cronInput) {
    presetSelect.addEventListener("change", () => {
      if (presetSelect.value !== "custom") {
        cronInput.value = presetSelect.value;
      }
    });
  }

  // Create schedule
  if (submitScheduleBtn) {
    submitScheduleBtn.addEventListener("click", async () => {
      if (!authState.currentProject) {
        showToast("Please select a project first", "error");
        return;
      }
      const name = document.getElementById("newSchName").value.trim();
      const cronExpr = document.getElementById("newSchCron").value.trim();
      const envName = document.getElementById("newSchEnv").value;
      const vus = parseInt(document.getElementById("newSchVus").value, 10);
      const duration = parseInt(document.getElementById("newSchDuration").value, 10);
      const p95 = parseInt(document.getElementById("newSchP95").value, 10);
      const errorRate = parseFloat(document.getElementById("newSchErrorRate").value);

      if (!name) {
        showToast("Schedule name is required", "error");
        return;
      }

      submitScheduleBtn.disabled = true;
      submitScheduleBtn.textContent = "Saving...";

      try {
        const res = await fetch(`/api/projects/${authState.currentProject.id}/schedules`, {
          method: "POST",
          headers: getAuthHeaders(),
          body: JSON.stringify({
            name,
            cronExpression: cronExpr,
            peakVus: vus,
            durationSec: duration,
            p95ThresholdMs: p95,
            maxErrorRatePct: errorRate
          })
        });
        const data = await res.json();
        if (res.ok) {
          showToast(`Schedule '${name}' created!`, "success");
          document.getElementById("newSchName").value = "";
          loadSchedules();
        } else {
          showToast(data.error || "Failed creating schedule", "error");
        }
      } catch (err) {
        showToast("Network error creating schedule", "error");
      } finally {
        submitScheduleBtn.disabled = false;
        submitScheduleBtn.textContent = "+ Save Benchmark Schedule";
      }
    });
  }

  // Create webhook
  if (submitWebhookBtn) {
    submitWebhookBtn.addEventListener("click", async () => {
      if (!authState.currentProject) {
        showToast("Please select a project first", "error");
        return;
      }
      const name = document.getElementById("newWebhookName").value.trim();
      const url = document.getElementById("newWebhookUrl").value.trim();
      const secret = document.getElementById("newWebhookSecret").value.trim();
      const evCompleted = document.getElementById("whEventCompleted").checked;
      const evFailed = document.getElementById("whEventFailed").checked;

      const events = [];
      if (evCompleted) events.push("run.completed");
      if (evFailed) events.push("sla.failed");

      if (!url) {
        showToast("Webhook URL is required", "error");
        return;
      }

      submitWebhookBtn.disabled = true;
      submitWebhookBtn.textContent = "Saving...";

      try {
        const res = await fetch(`/api/projects/${authState.currentProject.id}/webhooks`, {
          method: "POST",
          headers: getAuthHeaders(),
          body: JSON.stringify({ name, url, secret: secret || null, events })
        });
        const data = await res.json();
        if (res.ok) {
          showToast("Webhook registered successfully!", "success");
          document.getElementById("newWebhookName").value = "";
          document.getElementById("newWebhookUrl").value = "";
          document.getElementById("newWebhookSecret").value = "";
          loadWebhooks();
        } else {
          showToast(data.error || "Failed saving webhook", "error");
        }
      } catch (err) {
        showToast("Network error saving webhook", "error");
      } finally {
        submitWebhookBtn.disabled = false;
        submitWebhookBtn.textContent = "+ Save Webhook";
      }
    });
  }

  // Test webhook ping
  if (testWebhookBtn) {
    testWebhookBtn.addEventListener("click", async () => {
      const url = document.getElementById("newWebhookUrl").value.trim();
      const secret = document.getElementById("newWebhookSecret").value.trim();
      const fb = document.getElementById("testWebhookFeedback");

      if (!url) {
        showToast("Please enter a webhook URL to test", "error");
        return;
      }

      fb.textContent = "Sending test ping...";
      fb.style.color = "var(--text-muted)";

      try {
        const res = await fetch(`/api/projects/${authState.currentProject ? authState.currentProject.id : 'default'}/webhooks/test`, {
          method: "POST",
          headers: getAuthHeaders(),
          body: JSON.stringify({ url, secret: secret || null })
        });
        const data = await res.json();
        if (data.success) {
          fb.textContent = `✅ Ping delivered successfully! HTTP ${data.statusCode}`;
          fb.style.color = "var(--success)";
        } else {
          fb.textContent = `❌ Ping failed (HTTP ${data.statusCode}): ${data.error || data.body || 'No response'}`;
          fb.style.color = "var(--danger)";
        }
      } catch (err) {
        fb.textContent = `❌ Network error: ${err.message}`;
        fb.style.color = "var(--danger)";
      }
    });
  }

  // Dedicated Tab Schedules Controls
  const tabPresetSelect = document.getElementById("tabNewSchPreset");
  const tabCronInput = document.getElementById("tabNewSchCron");
  const tabSubmitScheduleBtn = document.getElementById("submitTabCreateScheduleBtn");
  const tabRefreshSchedulesBtn = document.getElementById("tabRefreshSchedulesBtn");

  if (tabPresetSelect && tabCronInput) {
    tabPresetSelect.addEventListener("change", () => {
      if (tabPresetSelect.value !== "custom") {
        tabCronInput.value = tabPresetSelect.value;
      }
    });
  }

  if (tabRefreshSchedulesBtn) {
    tabRefreshSchedulesBtn.addEventListener("click", () => loadSchedules());
  }

  if (tabSubmitScheduleBtn) {
    tabSubmitScheduleBtn.addEventListener("click", async () => {
      if (!authState.currentProject) {
        showToast("Please select a project first", "error");
        return;
      }
      const name = document.getElementById("tabNewSchName").value.trim();
      const cronExpr = document.getElementById("tabNewSchCron").value.trim();
      const envName = document.getElementById("tabNewSchEnv").value;
      const vus = parseInt(document.getElementById("tabNewSchVus").value, 10);
      const duration = parseInt(document.getElementById("tabNewSchDuration").value, 10);
      const p95 = parseInt(document.getElementById("tabNewSchP95").value, 10);
      const errorRate = parseFloat(document.getElementById("tabNewSchErrorRate").value);

      if (!name) {
        showToast("Schedule name is required", "error");
        return;
      }

      tabSubmitScheduleBtn.disabled = true;
      tabSubmitScheduleBtn.textContent = "Saving...";

      try {
        const res = await fetch(`/api/projects/${authState.currentProject.id}/schedules`, {
          method: "POST",
          headers: getAuthHeaders(),
          body: JSON.stringify({
            name,
            cronExpression: cronExpr,
            peakVus: vus,
            durationSec: duration,
            p95ThresholdMs: p95,
            maxErrorRatePct: errorRate,
            environmentName: envName
          })
        });
        const data = await res.json();
        if (res.ok) {
          showToast(`Schedule '${name}' created!`, "success");
          document.getElementById("tabNewSchName").value = "";
          loadSchedules();
        } else {
          showToast(data.error || "Failed creating schedule", "error");
        }
      } catch (err) {
        showToast("Network error creating schedule", "error");
      } finally {
        tabSubmitScheduleBtn.disabled = false;
        tabSubmitScheduleBtn.textContent = "+ Save Benchmark Schedule";
      }
    });
  }

  // Dedicated Tab Webhooks Controls
  const tabSubmitWebhookBtn = document.getElementById("submitTabCreateWebhookBtn");
  const tabTestWebhookBtn = document.getElementById("tabTestWebhookBtn");
  const tabRefreshWebhooksBtn = document.getElementById("tabRefreshWebhooksBtn");

  if (tabRefreshWebhooksBtn) {
    tabRefreshWebhooksBtn.addEventListener("click", () => loadWebhooks());
  }

  if (tabSubmitWebhookBtn) {
    tabSubmitWebhookBtn.addEventListener("click", async () => {
      if (!authState.currentProject) {
        showToast("Please select a project first", "error");
        return;
      }
      const name = document.getElementById("tabNewWebhookName").value.trim();
      const url = document.getElementById("tabNewWebhookUrl").value.trim();
      const secret = document.getElementById("tabNewWebhookSecret").value.trim();
      const evCompleted = document.getElementById("tabWhEventCompleted").checked;
      const evFailed = document.getElementById("tabWhEventFailed").checked;

      const events = [];
      if (evCompleted) events.push("run.completed");
      if (evFailed) events.push("sla.failed");

      if (!url) {
        showToast("Webhook URL is required", "error");
        return;
      }

      tabSubmitWebhookBtn.disabled = true;
      tabSubmitWebhookBtn.textContent = "Saving...";

      try {
        const res = await fetch(`/api/projects/${authState.currentProject.id}/webhooks`, {
          method: "POST",
          headers: getAuthHeaders(),
          body: JSON.stringify({ name, url, secret: secret || null, events })
        });
        const data = await res.json();
        if (res.ok) {
          showToast("Webhook registered successfully!", "success");
          document.getElementById("tabNewWebhookName").value = "";
          document.getElementById("tabNewWebhookUrl").value = "";
          document.getElementById("tabNewWebhookSecret").value = "";
          loadWebhooks();
        } else {
          showToast(data.error || "Failed saving webhook", "error");
        }
      } catch (err) {
        showToast("Network error saving webhook", "error");
      } finally {
        tabSubmitWebhookBtn.disabled = false;
        tabSubmitWebhookBtn.textContent = "+ Save Webhook";
      }
    });
  }

  if (tabTestWebhookBtn) {
    tabTestWebhookBtn.addEventListener("click", async () => {
      const url = document.getElementById("tabNewWebhookUrl").value.trim();
      const secret = document.getElementById("tabNewWebhookSecret").value.trim();
      const fb = document.getElementById("tabTestWebhookFeedback");

      if (!url) {
        showToast("Please enter a webhook URL to test", "error");
        return;
      }

      fb.textContent = "Sending test ping...";
      fb.style.color = "var(--text-muted)";

      try {
        const res = await fetch(`/api/projects/${authState.currentProject ? authState.currentProject.id : 'default'}/webhooks/test`, {
          method: "POST",
          headers: getAuthHeaders(),
          body: JSON.stringify({ url, secret: secret || null })
        });
        const data = await res.json();
        if (data.success) {
          fb.textContent = `✅ Ping delivered successfully! HTTP ${data.statusCode}`;
          fb.style.color = "var(--success)";
        } else {
          fb.textContent = `❌ Ping failed (HTTP ${data.statusCode}): ${data.error || data.body || 'No response'}`;
          fb.style.color = "var(--danger)";
        }
      } catch (err) {
        fb.textContent = `❌ Network error: ${err.message}`;
        fb.style.color = "var(--danger)";
      }
    });
  }
}

async function loadSchedules() {
  if (!authState.currentProject) return;
  const targetTbodies = [
    document.getElementById("schedulesTableBody"),
    document.getElementById("schedulesTabTableBody")
  ].filter(Boolean);

  if (targetTbodies.length === 0) return;

  try {
    const res = await fetch(`/api/projects/${authState.currentProject.id}/schedules`, {
      headers: getAuthHeaders()
    });
    if (!res.ok) {
      targetTbodies.forEach(tb => {
        tb.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 14px;">Unable to fetch schedules.</td></tr>`;
      });
      return;
    }
    const schedules = await res.json();

    targetTbodies.forEach(tbody => {
      tbody.innerHTML = "";
      if (schedules.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 14px;">No recurring schedules configured for this project yet.</td></tr>`;
        return;
      }

      schedules.forEach(s => {
        const tr = document.createElement("tr");
        const statusClass = s.last_run_status === 'passed' ? 'status-pass' : (s.last_run_status === 'failed' ? 'status-fail' : (s.last_run_status === 'running' ? 'status-running' : 'status-pending'));
        const activeBadge = s.is_active
          ? `<span class="badge" style="background-color: rgba(40,167,69,0.15); color: #28a745; font-size: 11px;">Active</span>`
          : `<span class="badge" style="background-color: rgba(108,117,125,0.15); color: #6c757d; font-size: 11px;">Paused</span>`;

        tr.innerHTML = `
          <td>
            <div style="font-weight: 600; color: var(--text);">${escapeHtml(s.name)}</div>
            <div style="margin-top: 2px;">${activeBadge}</div>
          </td>
          <td>
            <span style="font-family: var(--font-mono); font-size: 12px; background-color: var(--card-bg-subtle); padding: 2px 6px; border-radius: 3px; border: 1px solid var(--border);">
              ${escapeHtml(s.cron_expression)}
            </span>
          </td>
          <td style="font-size: 12px; color: var(--text-muted);">${escapeHtml(s.environment_name || 'staging')}</td>
          <td style="font-size: 12px; font-family: var(--font-mono);">${s.peak_vus || 20} VUs / ${s.duration_sec || 10}s</td>
          <td>
            <span class="badge ${statusClass}" style="font-size: 10px; text-transform: uppercase;">
              ${escapeHtml(s.last_run_status || 'never')}
            </span>
            <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">
              ${s.last_run_at ? new Date(s.last_run_at).toLocaleTimeString() : 'No runs yet'}
            </div>
          </td>
          <td style="text-align: right; white-space: nowrap;">
            <button class="btn btn-sm btn-secondary sch-run-btn" data-id="${s.id}" title="Run Now" style="padding: 3px 8px; font-size: 11px;">
              ▶ Run
            </button>
            <button class="btn btn-sm btn-dark sch-toggle-btn" data-id="${s.id}" data-active="${s.is_active}" title="${s.is_active ? 'Pause Schedule' : 'Enable Schedule'}" style="padding: 3px 8px; font-size: 11px;">
              ${s.is_active ? '⏸ Pause' : '▶ Enable'}
            </button>
            <button class="btn btn-sm btn-danger sch-del-btn" data-id="${s.id}" title="Delete Schedule" style="padding: 3px 8px; font-size: 11px;">
              ✕
            </button>
          </td>
        `;
        tbody.appendChild(tr);
      });

      // Wire up row buttons
      tbody.querySelectorAll(".sch-run-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const id = btn.getAttribute("data-id");
          btn.disabled = true;
          btn.textContent = "Triggering...";
          try {
            const res = await fetch(`/api/projects/${authState.currentProject.id}/schedules/${id}/trigger`, {
              method: "POST",
              headers: getAuthHeaders()
            });
            const d = await res.json();
            if (res.ok) {
              showToast("Benchmark triggered in background!", "success");
              loadSchedules();
            } else {
              showToast(d.error || "Failed triggering schedule", "error");
            }
          } catch (_) {
            showToast("Network error", "error");
          } finally {
            btn.disabled = false;
            btn.textContent = "▶ Run";
          }
        });
      });

      tbody.querySelectorAll(".sch-toggle-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const id = btn.getAttribute("data-id");
          const isCurrentActive = btn.getAttribute("data-active") === "true";
          try {
            const res = await fetch(`/api/projects/${authState.currentProject.id}/schedules/${id}`, {
              method: "PUT",
              headers: getAuthHeaders(),
              body: JSON.stringify({ isActive: !isCurrentActive })
            });
            if (res.ok) {
              showToast(!isCurrentActive ? "Schedule enabled!" : "Schedule paused", "info");
              loadSchedules();
            }
          } catch (_) {
            showToast("Failed updating schedule", "error");
          }
        });
      });

      tbody.querySelectorAll(".sch-del-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          if (!confirm("Delete this automated benchmark schedule?")) return;
          const id = btn.getAttribute("data-id");
          try {
            const res = await fetch(`/api/projects/${authState.currentProject.id}/schedules/${id}`, {
              method: "DELETE",
              headers: getAuthHeaders()
            });
            if (res.ok) {
              showToast("Schedule removed", "info");
              loadSchedules();
            }
          } catch (_) {
            showToast("Failed deleting schedule", "error");
          }
        });
      });
    });

  } catch (err) {
    console.error("loadSchedules error:", err);
  }
}

async function loadWebhooks() {
  if (!authState.currentProject) return;
  const targetTbodies = [
    document.getElementById("webhooksTableBody"),
    document.getElementById("webhooksTabTableBody")
  ].filter(Boolean);

  if (targetTbodies.length === 0) return;

  try {
    const res = await fetch(`/api/projects/${authState.currentProject.id}/webhooks`, {
      headers: getAuthHeaders()
    });
    if (!res.ok) {
      targetTbodies.forEach(tb => {
        tb.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 14px;">Unable to fetch webhooks.</td></tr>`;
      });
      return;
    }
    const webhooks = await res.json();

    targetTbodies.forEach(tbody => {
      tbody.innerHTML = "";
      if (webhooks.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 14px;">No alert webhooks configured yet.</td></tr>`;
        return;
      }

      webhooks.forEach(wh => {
        const tr = document.createElement("tr");
        let eventsArr = [];
        try {
          eventsArr = typeof wh.events === "string" ? JSON.parse(wh.events) : wh.events;
        } catch (_) {
          eventsArr = ["run.completed"];
        }

        const eventsPills = eventsArr.map(e => `
          <span style="font-size: 10px; background-color: var(--card-bg-subtle); border: 1px solid var(--border); padding: 1px 5px; border-radius: 3px; font-family: var(--font-mono);">
            ${escapeHtml(e)}
          </span>
        `).join(" ");

        const statusBadge = wh.last_status_code
          ? (wh.last_status_code >= 200 && wh.last_status_code < 300
              ? `<span class="badge" style="background-color: rgba(40,167,69,0.15); color: #28a745; font-size: 11px;">HTTP ${wh.last_status_code}</span>`
              : `<span class="badge" style="background-color: rgba(220,53,69,0.15); color: #dc3545; font-size: 11px;">HTTP ${wh.last_status_code}</span>`)
          : `<span style="font-size: 11px; color: var(--text-muted);">Not dispatched yet</span>`;

        tr.innerHTML = `
          <td style="font-weight: 600; color: var(--text);">${escapeHtml(wh.name)}</td>
          <td style="font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            ${escapeHtml(wh.url)}
          </td>
          <td>${eventsPills}</td>
          <td>
            ${statusBadge}
            <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">
              ${wh.last_dispatched_at ? new Date(wh.last_dispatched_at).toLocaleTimeString() : ''}
            </div>
          </td>
          <td style="text-align: right;">
            <button class="btn btn-sm btn-danger wh-del-btn" data-id="${wh.id}" title="Remove Webhook" style="padding: 3px 8px; font-size: 11px;">
              ✕ Remove
            </button>
          </td>
        `;
        tbody.appendChild(tr);
      });

      tbody.querySelectorAll(".wh-del-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          if (!confirm("Remove this alert webhook?")) return;
          const id = btn.getAttribute("data-id");
          try {
            const res = await fetch(`/api/projects/${authState.currentProject.id}/webhooks/${id}`, {
              method: "DELETE",
              headers: getAuthHeaders()
            });
            if (res.ok) {
              showToast("Webhook removed", "info");
              loadWebhooks();
            }
          } catch (_) {
            showToast("Failed removing webhook", "error");
          }
        });
      });
    });

  } catch (err) {
    console.error("loadWebhooks error:", err);
  }
}

// Call initialization at DOM ready
document.addEventListener("DOMContentLoaded", () => {
  initSchedulesAndWebhooksUI();
});


