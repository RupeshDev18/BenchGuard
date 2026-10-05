/**
 * circuit-breaker-coordinator.js
 *
 * Centralized Synchronized Global Circuit Breaker Coordinator for BenchGuard.
 * Aggregates live failure events across all distributed k6 worker nodes and
 * triggers an immediate fleet-wide halt within 50ms when cumulative errors breach
 * the configured safety limit.
 */

class CircuitBreakerCoordinator {
  constructor(options = {}) {
    this.limit = Math.max(0, parseInt(options.limit || 0, 10));
    this.workersCount = Math.max(1, parseInt(options.workersCount || 1, 10));
    this.onTripped = options.onTripped || (() => {});
    this.onTelemetryUpdate = options.onTelemetryUpdate || (() => {});

    this.cumulativeErrors = 0;
    this.errorsByWorker = {};
    this.workerTelemetry = {};
    this.tripped = false;
    this.trippedDetails = null;
    this.startTime = Date.now();

    // Initialize per-worker tracking slots
    for (let i = 1; i <= this.workersCount; i++) {
      this.errorsByWorker[i] = 0;
      this.workerTelemetry[i] = {
        id: i,
        vus: 0,
        rps: 0,
        requests: 0,
        errors: 0,
        status: "INITIALIZING",
        lastSnippet: "",
        updatedAt: Date.now(),
      };
    }
  }

  /**
   * Record errors detected from a specific worker's stream.
   * Checks if cumulative errors across the entire fleet have breached the threshold.
   */
  recordErrors(workerId, count = 1, errorSnippet = "") {
    if (this.tripped) return false;

    const num = Math.max(1, parseInt(count, 10));
    this.cumulativeErrors += num;
    this.errorsByWorker[workerId] = (this.errorsByWorker[workerId] || 0) + num;

    if (this.workerTelemetry[workerId]) {
      this.workerTelemetry[workerId].errors = this.errorsByWorker[workerId];
      if (errorSnippet) {
        this.workerTelemetry[workerId].lastSnippet = errorSnippet.slice(0, 120);
      }
      this.workerTelemetry[workerId].updatedAt = Date.now();
    }

    // Check circuit breaker condition
    if (this.limit > 0 && this.cumulativeErrors >= this.limit && !this.tripped) {
      this.tripped = true;
      this.trippedDetails = {
        trippedAt: new Date().toISOString(),
        breachedAtElapsedMs: Date.now() - this.startTime,
        cumulativeErrors: this.cumulativeErrors,
        limit: this.limit,
        triggerWorkerId: workerId,
        errorsByWorker: { ...this.errorsByWorker },
        triggerSnippet: errorSnippet || "Threshold exceeded",
      };

      try {
        this.onTripped(this.trippedDetails);
      } catch (err) {
        console.error("[CircuitBreakerCoordinator] Error in onTripped callback:", err);
      }
      return true;
    }

    return false;
  }

  /**
   * Update instantaneous performance metrics for a specific worker.
   */
  updateWorkerMetrics(workerId, metrics = {}) {
    if (!this.workerTelemetry[workerId]) {
      this.workerTelemetry[workerId] = { id: workerId };
    }

    const current = this.workerTelemetry[workerId];
    if (metrics.vus !== undefined) current.vus = Number(metrics.vus);
    if (metrics.rps !== undefined) current.rps = Number(metrics.rps);
    if (metrics.requests !== undefined) current.requests = Number(metrics.requests);
    if (metrics.status !== undefined) current.status = metrics.status;
    current.updatedAt = Date.now();

    this.onTelemetryUpdate(this.getFleetSnapshot());
  }

  /**
   * Produce a complete, real-time snapshot of the entire distributed fleet.
   */
  getFleetSnapshot() {
    let totalVus = 0;
    let totalRps = 0;
    let totalRequests = 0;

    const workersList = Object.values(this.workerTelemetry).map((w) => {
      totalVus += w.vus || 0;
      totalRps += w.rps || 0;
      totalRequests += w.requests || 0;
      return { ...w };
    });

    const percent = this.limit > 0
      ? Math.min(100, Number(((this.cumulativeErrors / this.limit) * 100).toFixed(1)))
      : 0;

    return {
      enabled: this.limit > 0,
      limit: this.limit,
      cumulativeErrors: this.cumulativeErrors,
      thresholdPercent: percent,
      tripped: this.tripped,
      trippedDetails: this.trippedDetails,
      activeWorkersCount: this.workersCount,
      totalVus,
      totalRps: Number(totalRps.toFixed(1)),
      totalRequests,
      workers: workersList,
      timestamp: Date.now(),
    };
  }
}

module.exports = { CircuitBreakerCoordinator };
