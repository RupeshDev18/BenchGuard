/**
 * worker-registry.js
 *
 * Master Fleet Registry & Heartbeat Hub for BenchGuard.
 * Manages bi-directional WebSocket connections from remote containerized Worker Agents.
 * Tracks region locations, resource capacities, live status, and heartbeat liveness.
 */

const EventEmitter = require("events");

class WorkerRegistry extends EventEmitter {
  constructor() {
    super();
    this.workers = new Map(); // workerId -> WorkerNode
    this.agentSecret = process.env.BENCHGUARD_AGENT_SECRET || "benchguard-fleet-secret-2026";
    this.heartbeatIntervalMs = 5000;
    this.heartbeatTimeoutMs = 15000;

    // Start heartbeat monitor
    this._startLivenessMonitor();
  }

  /**
   * Validates and registers a new or reconnecting remote worker agent
   */
  register(ws, meta = {}) {
    const providedSecret = meta.secret || meta.token;
    if (this.agentSecret && providedSecret !== this.agentSecret) {
      ws.send(JSON.stringify({
        type: "REGISTER_ERROR",
        error: "Authentication failed. Invalid agent secret token."
      }));
      ws.close(4001, "Unauthorized");
      return null;
    }

    const workerId = meta.workerId || `worker-${meta.region || "default"}-${Date.now().toString(36)}`;
    const now = Date.now();

    const workerNode = {
      id: workerId,
      region: meta.region || "us-east-1",
      hostname: meta.hostname || "container-worker",
      platform: meta.platform || "linux",
      cpus: meta.cpus || 2,
      memoryMb: meta.memoryMb || 2048,
      maxVusCapacity: meta.maxVusCapacity || 500,
      status: "IDLE", // IDLE | ASSIGNED | EXECUTING | DRAINING | UNRESPONSIVE | OFFLINE
      tags: meta.tags || ["docker", "remote"],
      connectedAt: now,
      lastHeartbeat: now,
      pingLatencyMs: 0,
      cpuUsagePercent: 0,
      memoryUsagePercent: 0,
      currentJobId: null,
      ws
    };

    this.workers.set(workerId, workerNode);

    // Send registration acknowledgment
    ws.send(JSON.stringify({
      type: "REGISTER_ACK",
      status: "OK",
      workerId,
      heartbeatInterval: this.heartbeatIntervalMs
    }));

    this.emit("worker_registered", this._sanitize(workerNode));

    // Attach listeners to ws
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(workerId, msg);
      } catch (err) {
        console.warn(`[WorkerRegistry] Malformed message from ${workerId}:`, err.message);
      }
    });

    ws.on("close", () => {
      this.handleDisconnect(workerId);
    });

    ws.on("error", (err) => {
      console.warn(`[WorkerRegistry] Error on worker ${workerId}:`, err.message);
      this.handleDisconnect(workerId);
    });

    return workerNode;
  }

  /**
   * Handle incoming messages from remote worker agents
   */
  handleMessage(workerId, message) {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    switch (message.type) {
      case "HEARTBEAT": {
        worker.lastHeartbeat = Date.now();
        if (message.stats) {
          worker.cpuUsagePercent = message.stats.cpu || worker.cpuUsagePercent;
          worker.memoryUsagePercent = message.stats.memory || worker.memoryUsagePercent;
          if (message.clientTimestamp) {
            worker.pingLatencyMs = Math.max(1, Math.round(Date.now() - message.clientTimestamp));
          }
        }
        if (worker.status === "UNRESPONSIVE") {
          worker.status = worker.currentJobId ? "EXECUTING" : "IDLE";
          this.emit("worker_recovered", this._sanitize(worker));
        }
        // Echo back heartbeat ACK
        if (worker.ws && worker.ws.readyState === 1) {
          worker.ws.send(JSON.stringify({
            type: "HEARTBEAT_ACK",
            timestamp: Date.now()
          }));
        }
        break;
      }

      case "JOB_STARTED": {
        worker.status = "EXECUTING";
        worker.currentJobId = message.jobId;
        this.emit("job_started", { workerId, jobId: message.jobId });
        break;
      }

      case "TELEMETRY": {
        this.emit("worker_telemetry", {
          workerId,
          jobId: message.jobId,
          telemetry: message.telemetry
        });
        break;
      }

      case "LOG": {
        this.emit("worker_log", {
          workerId,
          jobId: message.jobId,
          stream: message.stream || "stdout",
          data: message.data
        });
        break;
      }

      case "JOB_COMPLETED": {
        worker.status = "IDLE";
        worker.currentJobId = null;
        this.emit("job_completed", {
          workerId,
          jobId: message.jobId,
          summary: message.summary,
          exitCode: message.exitCode ?? 0
        });
        break;
      }

      case "JOB_FAILED": {
        worker.status = "IDLE";
        worker.currentJobId = null;
        this.emit("job_failed", {
          workerId,
          jobId: message.jobId,
          error: message.error,
          exitCode: message.exitCode ?? 1
        });
        break;
      }

      case "CIRCUIT_BREAKER_TRIGGERED": {
        this.emit("circuit_breaker_triggered", {
          workerId,
          jobId: message.jobId,
          reason: message.reason,
          errorsCount: message.errorsCount
        });
        break;
      }

      default:
        this.emit("worker_message", { workerId, message });
        break;
    }
  }

  /**
   * Handle worker disconnection
   */
  handleDisconnect(workerId) {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    worker.status = "OFFLINE";
    this.emit("worker_disconnected", this._sanitize(worker));

    // Remove offline worker after 60s
    setTimeout(() => {
      if (this.workers.get(workerId)?.status === "OFFLINE") {
        this.workers.delete(workerId);
        this.emit("worker_removed", { workerId });
      }
    }, 60000);
  }

  /**
   * Get available idle workers for dispatching
   */
  getAvailableWorkers(count = 1, preferredRegion = null) {
    const active = Array.from(this.workers.values())
      .filter(w => w.status === "IDLE" && w.ws && w.ws.readyState === 1);

    if (preferredRegion) {
      active.sort((a, b) => {
        if (a.region === preferredRegion && b.region !== preferredRegion) return -1;
        if (b.region === preferredRegion && a.region !== preferredRegion) return 1;
        return 0;
      });
    }

    return active.slice(0, count);
  }

  /**
   * Dispatch a test job to a specific worker
   */
  dispatchJob(workerId, jobPayload) {
    const worker = this.workers.get(workerId);
    if (!worker || worker.status !== "IDLE" || !worker.ws || worker.ws.readyState !== 1) {
      throw new Error(`Worker ${workerId} is not available for dispatch (Status: ${worker?.status || "NOT_FOUND"})`);
    }

    worker.status = "ASSIGNED";
    worker.currentJobId = jobPayload.jobId;

    worker.ws.send(JSON.stringify({
      type: "ASSIGN_JOB",
      payload: jobPayload
    }));

    return true;
  }

  /**
   * Broadcast an urgent HALT signal to all active workers (Circuit Breaker trip)
   */
  haltAllWorkers(reason = "Circuit breaker tripped") {
    let sent = 0;
    for (const [workerId, worker] of this.workers.entries()) {
      if (worker.ws && worker.ws.readyState === 1 && (worker.status === "EXECUTING" || worker.status === "ASSIGNED")) {
        try {
          worker.ws.send(JSON.stringify({
            type: "HALT_JOB",
            reason,
            timestamp: Date.now()
          }));
          sent++;
        } catch (e) {
          console.warn(`[WorkerRegistry] Failed to send halt to ${workerId}:`, e.message);
        }
      }
    }
    return sent;
  }

  /**
   * Return fleet status list sanitized for API / Web UI
   */
  getAllWorkers() {
    return Array.from(this.workers.values()).map(w => this._sanitize(w));
  }

  /**
   * Sanitizes worker node object by stripping raw WebSocket socket
   */
  _sanitize(worker) {
    const { ws, ...safe } = worker;
    return safe;
  }

  /**
   * Liveness monitor: marks workers UNRESPONSIVE if heartbeat timed out
   */
  _startLivenessMonitor() {
    setInterval(() => {
      const now = Date.now();
      for (const [workerId, worker] of this.workers.entries()) {
        if (worker.status !== "OFFLINE") {
          if (now - worker.lastHeartbeat > this.heartbeatTimeoutMs) {
            if (worker.status !== "UNRESPONSIVE") {
              worker.status = "UNRESPONSIVE";
              this.emit("worker_unresponsive", this._sanitize(worker));
            }
          }
        }
      }
    }, this.heartbeatIntervalMs);
  }
}

// Export singleton instance
module.exports = new WorkerRegistry();
