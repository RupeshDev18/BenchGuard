/**
 * worker-pool.js
 *
 * Local Multi-Process Worker Pool for BenchGuard Distributed Load Testing.
 * Spawns multiple k6 child processes across CPU cores, slices execution segments,
 * supervises cumulative circuit breakers, and consolidates final reports.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { mergeMetrics } = require("./metrics-consolidator");
const { CircuitBreakerCoordinator } = require("./circuit-breaker-coordinator");

class WorkerPool {
  constructor(options = {}) {
    this.workersCount = Math.max(1, parseInt(options.workersCount || 1, 10));
    this.scriptPath = options.scriptPath;
    this.outDir = options.outDir || path.resolve(process.cwd(), "report-output");
    this.configPath = options.configPath;
    this.stopOnFailures = options.stopOnFailures || 0;
    this.onLog = options.onLog || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.onTelemetry = options.onTelemetry || (() => {});
    this.onCircuitBreakerTripped = options.onCircuitBreakerTripped || (() => {});

    this.workers = [];
    this.activeProcesses = [];
    this.isAborting = false;
    this.completedWorkers = 0;

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
      console.log(`\n[WorkerPool] Initializing distributed fleet with ${this.workersCount} worker nodes...`);
      this.onLog(`[WorkerPool] Initializing distributed fleet with ${this.workersCount} worker nodes...\n`, "stdout");

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
    });
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

    // 3. Inspect for real runtime failure patterns (avoiding summary metric labels like http_req_failed)
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
    this.onLog(`🚨 Halting all ${this.activeProcesses.length} workers in parallel...\n`, "stderr");

    // Immediate parallel termination of all workers
    for (const proc of this.activeProcesses) {
      try {
        proc.kill();
      } catch (_) {}
    }

    this.onCircuitBreakerTripped(details);
  }

  abort() {
    if (this.isAborting) return;
    this.isAborting = true;
    this.onLog(`\n[WorkerPool] Aborting distributed fleet by user request...\n`, "stderr");
    for (const proc of this.activeProcesses) {
      try {
        proc.kill();
      } catch (_) {}
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

    // Any worker failed?
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
