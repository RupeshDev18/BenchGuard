/**
 * worker-pool.js
 *
 * Hybrid Multi-Process & Remote Container Worker Pool for BenchGuard Distributed Load Testing.
 * Orchestrates test execution across local CPU cores or remote containerized worker nodes,
 * slices execution segments, supervises cumulative circuit breakers, and consolidates final reports.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { mergeMetrics } = require("./metrics-consolidator");
const { CircuitBreakerCoordinator } = require("./circuit-breaker-coordinator");
const workerRegistry = require("./worker-registry");

class WorkerPool {
  constructor(options = {}) {
    this.workersCount = Math.max(1, parseInt(options.workersCount || 1, 10));
    this.scriptPath = options.scriptPath;
    this.outDir = options.outDir || path.resolve(process.cwd(), "report-output");
    this.configPath = options.configPath;
    this.stopOnFailures = options.stopOnFailures || 0;
    this.distributedMode = options.distributedMode || "auto"; // "auto" | "remote" | "local"
    this.preferredRegion = options.preferredRegion || null;
    this.onLog = options.onLog || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.onTelemetry = options.onTelemetry || (() => {});
    this.onCircuitBreakerTripped = options.onCircuitBreakerTripped || (() => {});

    this.workers = [];
    this.activeProcesses = [];
    this.isAborting = false;
    this.completedWorkers = 0;
    this.isRemote = false;

    // Initialize the synchronized global coordinator
    this.coordinator = new CircuitBreakerCoordinator({
      limit: this.stopOnFailures,
      workersCount: this.workersCount,
      onTripped: (details) => this.handleCircuitBreakerTripped(details),
      onTelemetryUpdate: (snapshot) => this.onTelemetry(snapshot),
    });
  }

  async run() {
    return new Promise((resolve, reject) => {
      // Check for available remote container workers
      let remoteCandidates = [];
      if (this.distributedMode === "remote" || this.distributedMode === "auto") {
        remoteCandidates = workerRegistry.getAvailableWorkers(this.workersCount, this.preferredRegion);
      }

      if (this.distributedMode === "remote" && remoteCandidates.length === 0) {
        return reject(new Error("Remote distributed mode requested, but no remote worker agents are registered or idle."));
      }

      if (remoteCandidates.length > 0 && this.distributedMode !== "local") {
        this.isRemote = true;
        this.runRemote(remoteCandidates, resolve, reject);
      } else {
        this.runLocal(resolve, reject);
      }
    });
  }

  /**
   * Run using remote container worker agents
   */
  runRemote(remoteWorkers, resolve, reject) {
    const totalWorkers = remoteWorkers.length;
    console.log(`\n[WorkerPool] Launching distributed run across ${totalWorkers} REMOTE CONTAINER WORKER NODES...`);
    this.onLog(`[WorkerPool] Launching distributed run across ${totalWorkers} REMOTE CONTAINER WORKER NODES...\n`, "stdout");

    if (!fs.existsSync(this.outDir)) {
      fs.mkdirSync(this.outDir, { recursive: true });
    }

    const workerSummaryFiles = [];
    const scriptContent = fs.readFileSync(this.scriptPath, "utf8");
    const testJobBatchId = `job-${Date.now()}`;

    // Listener cleanup helper
    const cleanupListeners = [];

    remoteWorkers.forEach((workerNode, idx) => {
      const workerId = idx + 1;
      const remoteId = workerNode.id;
      const startSeg = `${idx}/${totalWorkers}`;
      const endSeg = `${idx + 1}/${totalWorkers}`;
      const executionSegment = `${startSeg}:${endSeg}`;
      const summaryFile = path.join(this.outDir, `worker-${workerId}-summary.json`);
      workerSummaryFiles.push(summaryFile);

      if (fs.existsSync(summaryFile)) {
        try { fs.unlinkSync(summaryFile); } catch (_) {}
      }

      this.workers.push({ id: workerId, remoteId, summaryFile, exitCode: null, segment: executionSegment });
      this.coordinator.updateWorkerMetrics(workerId, { status: "RUNNING" });

      console.log(`[WorkerPool] Dispatching segment ${executionSegment} to remote agent ${remoteId} (${workerNode.region})...`);
      this.onLog(`[WorkerPool] Dispatching segment ${executionSegment} to remote agent ${remoteId} (${workerNode.region})...\n`, "stdout");

      // Wire registry events for this worker
      const onWorkerLog = (evt) => {
        if (evt.workerId === remoteId && evt.jobId.startsWith(testJobBatchId)) {
          this.onLog(`[Worker-${workerId} @ ${workerNode.region}] ${evt.data}`, evt.stream || "stdout");
        }
      };

      const onWorkerTelemetry = (evt) => {
        if (evt.workerId === remoteId && evt.jobId.startsWith(testJobBatchId)) {
          if (evt.telemetry) {
            this.coordinator.updateWorkerMetrics(workerId, {
              vus: evt.telemetry.vus,
              rps: evt.telemetry.rps,
            });
          }
        }
      };

      const onJobCompleted = (evt) => {
        if (evt.workerId === remoteId && evt.jobId.startsWith(testJobBatchId)) {
          this.completedWorkers++;
          const w = this.workers.find((item) => item.id === workerId);
          if (w) w.exitCode = evt.exitCode ?? 0;

          if (evt.summary) {
            fs.writeFileSync(summaryFile, JSON.stringify(evt.summary, null, 2), "utf8");
          }

          const finalStatus = this.isAborting ? "HALTED" : (evt.exitCode === 0 ? "COMPLETED" : "FAILED");
          this.coordinator.updateWorkerMetrics(workerId, { status: finalStatus });

          this.onLog(`[WorkerPool] Remote Worker #${workerId} (${remoteId}) finished (code ${evt.exitCode}) [${this.completedWorkers}/${totalWorkers} done]\n`, "stdout");

          if (this.completedWorkers >= totalWorkers) {
            cleanupListeners.forEach(fn => fn());
            this.finalize(workerSummaryFiles, resolve, reject);
          }
        }
      };

      const onJobFailed = (evt) => {
        if (evt.workerId === remoteId && evt.jobId.startsWith(testJobBatchId)) {
          this.completedWorkers++;
          const w = this.workers.find((item) => item.id === workerId);
          if (w) w.exitCode = evt.exitCode ?? 1;

          this.coordinator.updateWorkerMetrics(workerId, { status: "FAILED" });
          this.onLog(`[WorkerPool] Remote Worker #${workerId} failed: ${evt.error}\n`, "stderr");

          if (this.completedWorkers >= totalWorkers) {
            cleanupListeners.forEach(fn => fn());
            this.finalize(workerSummaryFiles, resolve, reject);
          }
        }
      };

      const onCircuitBreaker = (evt) => {
        if (evt.workerId === remoteId && evt.jobId.startsWith(testJobBatchId)) {
          this.coordinator.recordErrors(workerId, evt.errorsCount || 1, evt.reason || "Remote threshold breach");
        }
      };

      workerRegistry.on("worker_log", onWorkerLog);
      workerRegistry.on("worker_telemetry", onWorkerTelemetry);
      workerRegistry.on("job_completed", onJobCompleted);
      workerRegistry.on("job_failed", onJobFailed);
      workerRegistry.on("circuit_breaker_triggered", onCircuitBreaker);

      cleanupListeners.push(() => {
        workerRegistry.removeListener("worker_log", onWorkerLog);
        workerRegistry.removeListener("worker_telemetry", onWorkerTelemetry);
        workerRegistry.removeListener("job_completed", onJobCompleted);
        workerRegistry.removeListener("job_failed", onJobFailed);
        workerRegistry.removeListener("circuit_breaker_triggered", onCircuitBreaker);
      });

      // Dispatch payload to worker
      const jobPayload = {
        jobId: `${testJobBatchId}-w${workerId}`,
        scriptContent,
        segment: executionSegment,
        vus: 0,
        envVars: {
          BENCHGUARD_WORKER_ID: String(workerId),
          BENCHGUARD_TOTAL_WORKERS: String(totalWorkers)
        }
      };

      workerRegistry.dispatchJob(remoteId, jobPayload);
    });

    // Initial telemetry snapshot
    this.onTelemetry(this.coordinator.getFleetSnapshot());
  }

  /**
   * Run using local child processes
   */
  runLocal(resolve, reject) {
    console.log(`\n[WorkerPool] Initializing local multi-process fleet with ${this.workersCount} worker nodes...`);
    this.onLog(`[WorkerPool] Initializing local multi-process fleet with ${this.workersCount} worker nodes...\n`, "stdout");

    if (!fs.existsSync(this.outDir)) {
      fs.mkdirSync(this.outDir, { recursive: true });
    }

    const workerSummaryFiles = [];

    for (let i = 0; i < this.workersCount; i++) {
      const workerId = i + 1;
      const startSeg = `${i}/${this.workersCount}`;
      const endSeg = `${i + 1}/${this.workersCount}`;
      const executionSegment = `${startSeg}:${endSeg}`;
      const summaryFile = path.join(this.outDir, `worker-${workerId}-summary.json`);
      workerSummaryFiles.push(summaryFile);

      // Clean any old summary
      if (fs.existsSync(summaryFile)) {
        try { fs.unlinkSync(summaryFile); } catch (_) {}
      }

      const args = [
        "run",
        `--summary-export="${summaryFile}"`,
        `--execution-segment=${executionSegment}`,
        `"${this.scriptPath}"`,
      ];

      console.log(`[WorkerPool] Spawning Worker #${workerId} (segment: ${executionSegment})...`);
      this.onLog(`[WorkerPool] Spawning Worker #${workerId} (segment: ${executionSegment})...\n`, "stdout");

      const proc = spawn("k6", args, {
        shell: true,
        cwd: path.dirname(this.scriptPath),
        env: {
          ...process.env,
          BENCHGUARD_WORKER_ID: String(workerId),
          BENCHGUARD_TOTAL_WORKERS: String(this.workersCount),
        },
      });

      this.activeProcesses.push(proc);
      this.workers.push({ id: workerId, proc, summaryFile, exitCode: null, segment: executionSegment });
      this.coordinator.updateWorkerMetrics(workerId, { status: "RUNNING" });

      proc.stdout.on("data", (data) => {
        const text = data.toString();
        this.onLog(`[Worker-${workerId}] ${text}`, "stdout");
        this.parseWorkerTelemetry(workerId, text);
      });

      proc.stderr.on("data", (data) => {
        const text = data.toString();
        this.onLog(`[Worker-${workerId}] ${text}`, "stderr");
        this.parseWorkerTelemetry(workerId, text);
      });

      proc.on("close", (code) => {
        this.completedWorkers++;
        const w = this.workers.find((item) => item.id === workerId);
        if (w) w.exitCode = code;

        const finalStatus = this.isAborting ? "HALTED" : (code === 0 ? "COMPLETED" : "FAILED");
        this.coordinator.updateWorkerMetrics(workerId, { status: finalStatus });

        this.onLog(`[WorkerPool] Worker #${workerId} finished with exit code ${code} (${this.completedWorkers}/${this.workersCount} done)\n`, "stdout");

        if (this.completedWorkers >= this.workersCount) {
          this.finalize(workerSummaryFiles, resolve, reject);
        }
      });

      proc.on("error", (err) => {
        this.coordinator.updateWorkerMetrics(workerId, { status: "ERROR" });
        this.onLog(`[WorkerPool] Error in Worker #${workerId}: ${err.message}\n`, "stderr");
      });
    }

    // Initial telemetry broadcast
    this.onTelemetry(this.coordinator.getFleetSnapshot());
  }

  parseWorkerTelemetry(workerId, text) {
    if (this.isAborting) return;

    // 1. Extract VUs (e.g., "0/5 VUs", "10 VUs", "vus: 5")
    const vuMatch = text.match(/(\d+)\/(\d+)\s+VUs|(\d+)\s+VUs/i);
    let currentVus = null;
    if (vuMatch) {
      currentVus = parseInt(vuMatch[1] || vuMatch[3], 10);
    }

    // 2. Extract RPS rate if present in line
    const rpsMatch = text.match(/([\d.]+)\/s/);
    let currentRps = null;
    if (rpsMatch) {
      currentRps = parseFloat(rpsMatch[1]);
    }

    if (currentVus !== null || currentRps !== null) {
      this.coordinator.updateWorkerMetrics(workerId, {
        vus: currentVus !== null ? currentVus : undefined,
        rps: currentRps !== null ? currentRps : undefined,
      });
    }

    // 3. Inspect for real runtime failure patterns
    const isSummaryLine = /http_req_failed|checks_failed\.*:\s*0|checks_failed\.*:\s*0\.00%/i.test(text);
    if (!isSummaryLine) {
      const failedCheckCount = (text.match(/✗/g) || []).length;
      const httpErrorCount = (text.match(/status >= 400|status is 5\d\d|status in \[5\d\d|connection refused|request timeout|context deadline exceeded/gi) || []).length;
      const k6ErrorCount = (text.match(/level=error|ERRO\[\d+\]/gi) || []).length;
      
      const realFailures = Math.max(failedCheckCount, httpErrorCount + k6ErrorCount);
      if (realFailures > 0) {
        this.coordinator.recordErrors(workerId, realFailures, text.trim());
      }
    }
  }

  handleCircuitBreakerTripped(details) {
    if (this.isAborting) return;
    this.isAborting = true;

    console.warn(`\n🚨 [WorkerPool] GLOBAL CIRCUIT BREAKER TRIPPED!`);
    console.warn(`🚨 Limit: ${details.limit} | Cumulative Failures: ${details.cumulativeErrors}`);
    console.warn(`🚨 Triggered by Worker #${details.triggerWorkerId}`);

    this.onLog(`\n🚨 [WorkerPool] GLOBAL CIRCUIT BREAKER TRIPPED: Cumulative failures breached safety limit (${details.cumulativeErrors} >= ${details.limit})!\n`, "stderr");
    
    if (this.isRemote) {
      this.onLog(`🚨 Broadcasting emergency HALT signal to all remote container workers...\n`, "stderr");
      workerRegistry.haltAllWorkers(`Circuit breaker tripped on master (${details.cumulativeErrors} errors)`);
    } else {
      this.onLog(`🚨 Halting all ${this.activeProcesses.length} local workers in parallel...\n`, "stderr");
      for (const proc of this.activeProcesses) {
        try { proc.kill(); } catch (_) {}
      }
    }

    this.onCircuitBreakerTripped(details);
  }

  abort() {
    if (this.isAborting) return;
    this.isAborting = true;
    this.onLog(`\n[WorkerPool] Aborting distributed fleet by user request...\n`, "stderr");
    
    if (this.isRemote) {
      workerRegistry.haltAllWorkers("Aborted by user request");
    } else {
      for (const proc of this.activeProcesses) {
        try { proc.kill(); } catch (_) {}
      }
    }
  }

  finalize(summaryFiles, resolve, reject) {
    console.log(`\n[WorkerPool] All workers completed. Consolidating distributed metrics...`);
    this.onLog(`\n[WorkerPool] All workers completed. Consolidating distributed metrics...\n`, "stdout");

    const validSummaries = [];
    for (const file of summaryFiles) {
      if (fs.existsSync(file)) {
        try {
          const raw = fs.readFileSync(file, "utf8");
          validSummaries.push(JSON.parse(raw));
        } catch (e) {
          console.warn(`[WorkerPool] Could not parse worker summary ${file}: ${e.message}`);
        }
      }
    }

    if (validSummaries.length === 0) {
      console.warn(`[WorkerPool] No worker summaries found to consolidate.`);
      return resolve({
        success: false,
        exitCode: 1,
        summary: null,
        workerCount: this.workersCount,
      });
    }

    const consolidated = mergeMetrics(validSummaries);
    const finalSummaryPath = path.join(this.outDir, "k6-summary.json");
    fs.writeFileSync(finalSummaryPath, JSON.stringify(consolidated, null, 2), "utf8");

    console.log(`[WorkerPool] Successfully wrote consolidated metrics to ${finalSummaryPath}`);
    this.onLog(`[WorkerPool] Successfully wrote consolidated metrics to ${finalSummaryPath}\n`, "stdout");

    const hasFailures = this.workers.some((w) => w.exitCode !== 0);

    resolve({
      success: !hasFailures && !this.isAborting,
      exitCode: hasFailures ? 1 : 0,
      summary: consolidated,
      workerCount: this.workersCount,
    });
  }
}

module.exports = { WorkerPool };
