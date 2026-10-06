/**
 * remote-worker-agent.js
 *
 * Standalone Remote Worker Agent for BenchGuard Distributed Load Testing.
 * Runs in Docker containers, cloud VMs, or remote edge regions.
 * Connects to BenchGuard Master Hub via WebSocket, executes assigned k6 jobs,
 * streams real-time telemetry, and supports instant remote circuit breaker halts.
 */

const WebSocket = require("ws");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// Configuration from CLI flags or Environment Variables
const args = process.argv.slice(2);
function getArg(flag, envVar, fallback) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return process.env[envVar] || fallback;
}

const MASTER_URL = getArg("--master", "BENCHGUARD_MASTER_URL", "ws://localhost:3000/ws/worker-fleet");
const AGENT_SECRET = getArg("--secret", "BENCHGUARD_AGENT_SECRET", "benchguard-fleet-secret-2026");
const REGION = getArg("--region", "BENCHGUARD_REGION", "us-east-1");
const WORKER_ID = getArg("--worker-id", "BENCHGUARD_WORKER_ID", `worker-${REGION}-${os.hostname()}-${Math.floor(Math.random() * 10000)}`);
const MAX_VUS = parseInt(getArg("--max-vus", "BENCHGUARD_MAX_VUS", "500"), 10);
const K6_BIN = getArg("--k6-bin", "K6_BIN", process.platform === "win32" ? "k6.exe" : "k6");

class RemoteWorkerAgent {
  constructor() {
    this.masterUrl = MASTER_URL;
    this.workerId = WORKER_ID;
    this.region = REGION;
    this.secret = AGENT_SECRET;
    this.maxVus = MAX_VUS;
    this.k6Bin = K6_BIN;

    this.ws = null;
    this.heartbeatTimer = null;
    this.currentJob = null;
    this.currentProcess = null;
    this.reconnectTimeout = null;
    this.isReconnecting = false;
  }

  start() {
    console.log(`[Agent ${this.workerId}] Starting BenchGuard Remote Worker Agent...`);
    console.log(`[Agent ${this.workerId}] Master URL : ${this.masterUrl}`);
    console.log(`[Agent ${this.workerId}] Region     : ${this.region}`);
    console.log(`[Agent ${this.workerId}] Max VUs    : ${this.maxVus}`);
    console.log(`[Agent ${this.workerId}] CPUs       : ${os.cpus().length} cores | Memory: ${Math.round(os.totalmem() / 1024 / 1024)} MB`);

    this.connect();
  }

  connect() {
    if (this.isReconnecting) return;

    try {
      console.log(`[Agent ${this.workerId}] Connecting to Master Hub at ${this.masterUrl}...`);
      this.ws = new WebSocket(this.masterUrl, {
        headers: {
          "x-benchguard-secret": this.secret
        }
      });

      this.ws.on("open", () => {
        console.log(`[Agent ${this.workerId}] Connected to Master Hub. Sending registration handshake...`);
        this._sendRegistration();
      });

      this.ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.handleMasterMessage(msg);
        } catch (e) {
          console.warn(`[Agent ${this.workerId}] Malformed master message:`, e.message);
        }
      });

      this.ws.on("close", (code, reason) => {
        console.warn(`[Agent ${this.workerId}] Disconnected from Master (Code: ${code}, Reason: ${reason || "None"}).`);
        this._cleanupConnection();
        this.scheduleReconnect();
      });

      this.ws.on("error", (err) => {
        console.warn(`[Agent ${this.workerId}] WebSocket error:`, err.message);
        this._cleanupConnection();
        this.scheduleReconnect();
      });

    } catch (err) {
      console.warn(`[Agent ${this.workerId}] Connection creation error:`, err.message);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimeout) return;
    this.isReconnecting = true;
    const delay = 3000 + Math.floor(Math.random() * 2000);
    console.log(`[Agent ${this.workerId}] Reconnecting to Master in ${delay}ms...`);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.isReconnecting = false;
      this.connect();
    }, delay);
  }

  _cleanupConnection() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      try { this.ws.terminate(); } catch (_) {}
      this.ws = null;
    }
  }

  _sendRegistration() {
    const meta = {
      type: "REGISTER",
      secret: this.secret,
      workerId: this.workerId,
      region: this.region,
      hostname: os.hostname(),
      platform: os.platform(),
      cpus: os.cpus().length,
      memoryMb: Math.round(os.totalmem() / 1024 / 1024),
      maxVusCapacity: this.maxVus,
      tags: ["docker", "remote", this.region]
    };

    this.send(meta);
  }

  handleMasterMessage(msg) {
    switch (msg.type) {
      case "REGISTER_ACK": {
        console.log(`[Agent ${this.workerId}] Successfully registered with Master! Heartbeat interval: ${msg.heartbeatInterval || 5000}ms`);
        this._startHeartbeat(msg.heartbeatInterval || 5000);
        break;
      }

      case "REGISTER_ERROR": {
        console.error(`[Agent ${this.workerId}] Registration rejected:`, msg.error);
        break;
      }

      case "HEARTBEAT_ACK": {
        // Heartbeat acknowledged
        break;
      }

      case "ASSIGN_JOB": {
        console.log(`[Agent ${this.workerId}] Received test job assignment: Job ID ${msg.payload?.jobId}`);
        this.executeJob(msg.payload);
        break;
      }

      case "HALT_JOB": {
        console.warn(`[Agent ${this.workerId}] EMERGENCY HALT signal received from Master:`, msg.reason);
        this.haltCurrentJob(msg.reason);
        break;
      }

      default:
        console.log(`[Agent ${this.workerId}] Unknown message from master:`, msg.type);
    }
  }

  _startHeartbeat(intervalMs) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const freeMem = os.freemem();
        const totalMem = os.totalmem();
        const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);

        this.send({
          type: "HEARTBEAT",
          clientTimestamp: Date.now(),
          stats: {
            cpu: Math.min(100, Math.round(os.loadavg()[0] * 10)),
            memory: memPercent
          }
        });
      }
    }, intervalMs);
  }

  async executeJob(payload) {
    if (this.currentProcess) {
      this.send({
        type: "JOB_FAILED",
        jobId: payload.jobId,
        error: "Worker is already executing a job"
      });
      return;
    }

    const { jobId, scriptContent, segment, vus, duration, envVars } = payload;
    this.currentJob = { jobId };

    // Create temp run directory
    const tempDir = path.join(os.tmpdir(), "benchguard-agent", jobId);
    fs.mkdirSync(tempDir, { recursive: true });

    const scriptPath = path.join(tempDir, "test.js");
    fs.writeFileSync(scriptPath, scriptContent, "utf8");

    const summaryPath = path.join(tempDir, "k6-summary.json");

    // Build k6 command arguments
    const k6Args = [
      "run",
      `--summary-export=${summaryPath}`,
      scriptPath
    ];

    if (segment) {
      k6Args.push(`--execution-segment=${segment}`);
    }

    // Merge environment variables
    const childEnv = Object.assign({}, process.env, envVars || {}, {
      BENCHGUARD_JOB_ID: jobId,
      BENCHGUARD_WORKER_ID: this.workerId,
      K6_SUMMARY_EXPORT: summaryPath
    });

    console.log(`[Agent ${this.workerId}] Spawning k6 engine for job ${jobId}...`);
    this.send({ type: "JOB_STARTED", jobId });

    let lastVus = vus || 0;
    let lastRps = 0;

    const child = spawn(this.k6Bin, k6Args, {
      env: childEnv,
      shell: process.platform === "win32"
    });

    this.currentProcess = child;

    const processStream = (streamName, data) => {
      const text = data.toString();
      // Send log line
      this.send({
        type: "LOG",
        jobId,
        stream: streamName,
        data: text
      });

      // Parse live telemetry from k6 stdout
      const vuMatch = text.match(/([0-9]+)\/([0-9]+)\s+VUs/);
      if (vuMatch) lastVus = parseInt(vuMatch[1], 10);

      const rpsMatch = text.match(/http_reqs[\.\s]+:\s+[0-9\.]+\s+([0-9\.]+)\/s/);
      if (rpsMatch) lastRps = parseFloat(rpsMatch[1]);

      if (vuMatch || rpsMatch) {
        this.send({
          type: "TELEMETRY",
          jobId,
          telemetry: {
            vus: lastVus,
            rps: lastRps
          }
        });
      }

      // Check for errors / thresholds
      if (text.includes("thresholds on metrics") && text.includes("were crossed")) {
        this.send({
          type: "CIRCUIT_BREAKER_TRIGGERED",
          jobId,
          reason: "k6 thresholds crossed with abortOnFail enabled"
        });
      }
    };

    child.stdout.on("data", (data) => processStream("stdout", data));
    child.stderr.on("data", (data) => processStream("stderr", data));

    child.on("close", (exitCode) => {
      console.log(`[Agent ${this.workerId}] k6 process exited with code ${exitCode}`);
      this.currentProcess = null;

      let summaryData = null;
      if (fs.existsSync(summaryPath)) {
        try {
          summaryData = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
        } catch (e) {
          console.warn(`[Agent ${this.workerId}] Failed to parse summary JSON:`, e.message);
        }
      }

      // Cleanup temp files
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {}

      if (exitCode === 0 || summaryData) {
        this.send({
          type: "JOB_COMPLETED",
          jobId,
          exitCode: exitCode || 0,
          summary: summaryData
        });
      } else {
        this.send({
          type: "JOB_FAILED",
          jobId,
          exitCode: exitCode || 1,
          error: `k6 exited with code ${exitCode} without valid summary`
        });
      }

      this.currentJob = null;
    });

    child.on("error", (err) => {
      console.error(`[Agent ${this.workerId}] Failed to start k6 process:`, err.message);
      this.currentProcess = null;
      this.currentJob = null;
      this.send({
        type: "JOB_FAILED",
        jobId,
        error: err.message
      });
    });
  }

  haltCurrentJob(reason) {
    if (this.currentProcess) {
      console.warn(`[Agent ${this.workerId}] Halting active k6 process immediately: ${reason}`);
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", this.currentProcess.pid.toString(), "/f", "/t"]);
        } else {
          this.currentProcess.kill("SIGTERM");
          setTimeout(() => {
            if (this.currentProcess) this.currentProcess.kill("SIGKILL");
          }, 200);
        }
      } catch (err) {
        console.warn(`[Agent ${this.workerId}] Process termination error:`, err.message);
      }
    }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch (e) {
        console.warn(`[Agent ${this.workerId}] WebSocket send error:`, e.message);
      }
    }
  }
}

// If invoked directly from CLI, start the agent
if (require.main === module) {
  const agent = new RemoteWorkerAgent();
  agent.start();

  process.on("SIGINT", () => {
    console.log("\n[Agent] Shutting down...");
    agent._cleanupConnection();
    process.exit(0);
  });
}

module.exports = RemoteWorkerAgent;
