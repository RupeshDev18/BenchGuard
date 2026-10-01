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

class WorkerPool {
  constructor(options = {}) {
    this.workersCount = Math.max(1, parseInt(options.workersCount || 1, 10));
    this.scriptPath = options.scriptPath;
    this.outDir = options.outDir || path.resolve(process.cwd(), "report-output");
    this.configPath = options.configPath;
    this.stopOnFailures = options.stopOnFailures || 0;
    this.onLog = options.onLog || (() => {});
    this.onStatus = options.onStatus || (() => {});

    this.workers = [];
    this.activeProcesses = [];
    this.cumulativeFailures = 0;
    this.isAborting = false;
    this.completedWorkers = 0;
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
        this.workers.push({ id: workerId, proc, summaryFile, exitCode: null });

        proc.stdout.on("data", (data) => {
          const text = data.toString();
          this.onLog(`[Worker-${workerId}] ${text}`, "stdout");
          this.inspectForFailures(text);
        });

        proc.stderr.on("data", (data) => {
          const text = data.toString();
          this.onLog(`[Worker-${workerId}] ${text}`, "stderr");
          this.inspectForFailures(text);
        });

        proc.on("close", (code) => {
          this.completedWorkers++;
          const w = this.workers.find((item) => item.id === workerId);
          if (w) w.exitCode = code;

          this.onLog(`[WorkerPool] Worker #${workerId} finished with exit code ${code} (${this.completedWorkers}/${this.workersCount} done)\n`, "stdout");

          if (this.completedWorkers >= this.workersCount) {
            this.finalize(workerSummaryFiles, resolve, reject);
          }
        });

        proc.on("error", (err) => {
          this.onLog(`[WorkerPool] Error in Worker #${workerId}: ${err.message}\n`, "stderr");
        });
      }
    });
  }

  inspectForFailures(text) {
    if (this.stopOnFailures <= 0 || this.isAborting) return;

    // Detect error patterns in k6 stdout (e.g., status >= 400 or threshold breach or explicit check failure)
    const failMatches = (text.match(/status >= 400|status is 5\d\d|error|failed/gi) || []).length;
    if (failMatches > 0) {
      this.cumulativeFailures += failMatches;
      if (this.cumulativeFailures >= this.stopOnFailures) {
        this.triggerGlobalAbort(`Cumulative failure threshold breached (${this.cumulativeFailures} >= ${this.stopOnFailures})`);
      }
    }
  }

  triggerGlobalAbort(reason) {
    if (this.isAborting) return;
    this.isAborting = true;
    console.warn(`\n🚨 [WorkerPool] CIRCUIT BREAKER TRIPPED: ${reason}! Halting all workers...`);
    this.onLog(`\n🚨 [WorkerPool] CIRCUIT BREAKER TRIPPED: ${reason}! Halting all workers...\n`, "stderr");

    for (const proc of this.activeProcesses) {
      try {
        proc.kill();
      } catch (_) {}
    }
  }

  abort() {
    this.triggerGlobalAbort("Aborted by user / orchestrator");
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
