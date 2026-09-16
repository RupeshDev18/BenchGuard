#!/usr/bin/env node
/**
 * run-contract.js
 *
 * Runs Schemathesis contract checks against the target OpenAPI spec and baseUrl
 * if contractTesting.enabled is true in config.json.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function getArg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const configPath = path.resolve(process.cwd(), getArg("config", "config.json"));
const outDir = path.resolve(process.cwd(), getArg("out", "report-output"));

if (!fs.existsSync(configPath)) {
  console.error(`[run-contract] Config not found: ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (!config.contractTesting || !config.contractTesting.enabled) {
  console.log("[run-contract] Contract testing is disabled in config.json. Skipping.");
  process.exit(0);
}

// Check if Python & schemathesis are installed
let hasSchemathesis = false;
try {
  execSync("schemathesis --version", { stdio: "pipe" });
  hasSchemathesis = true;
} catch (e) {
  try {
    execSync("python -m schemathesis --version", { stdio: "pipe" });
    hasSchemathesis = true;
  } catch (err) {
    hasSchemathesis = false;
  }
}

if (!hasSchemathesis) {
  console.warn("\n[run-contract] WARNING: 'schemathesis' is enabled in config, but not found on PATH.");
  console.warn("  To enable contract checks, run: pip install schemathesis");
  console.warn("  Skipping contract testing for this run.\n");
  process.exit(0);
}

const openapiFile = path.resolve(path.dirname(configPath), config.openapiPath);
const baseUrl = config.baseUrl || "http://localhost:8080";
const rawXml = path.join(outDir, "contract-raw.xml");
const summaryJson = path.join(outDir, "contract-summary.json");

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

console.log(`[run-contract] Running Schemathesis against ${baseUrl} with spec ${openapiFile}...`);
try {
  execSync(`schemathesis run "${openapiFile}" --url "${baseUrl}" --junit-xml="${rawXml}"`, {
    stdio: "inherit",
  });
} catch (err) {
  console.log("[run-contract] Schemathesis finished with some test violations (normal for contract validation).");
}

if (fs.existsSync(rawXml)) {
  const parserScript = path.join(__dirname, "parse-schemathesis-junit.py");
  try {
    execSync(`python "${parserScript}" --in "${rawXml}" --out "${summaryJson}"`, {
      stdio: "inherit",
    });
  } catch (err) {
    console.error(`[run-contract] Failed parsing JUnit XML: ${err.message}`);
  }
}
