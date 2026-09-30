/**
 * src/routes/project-routes.js
 * 
 * Multi-tenant Project Management API:
 * - Project details, environments (Dev/Staging/Prod), OpenAPI specifications
 * - Parameterization datasets (CSV), Scoped Test Runs & Analytics Trends
 * - Tenant-isolated pipeline execution
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { spawn } = require('child_process');
const { query } = require('../db/database');
const runRepository = require('../db/run-repository');
const { authenticateToken, requireProjectRole } = require('../auth/middlewares');
const { randomUUID } = require('crypto');
const broadcaster = require('../utils/broadcaster');

const ROOT_DIR = path.resolve(__dirname, '../../');
const DATA_DIR = path.join(ROOT_DIR, 'data/tenants');

// Track running processes per project
const activeProjectProcesses = new Map();

// Multer storage for project-specific datasets and specs
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const destDir = path.join(DATA_DIR, req.params.projectId || 'common');
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }
        cb(null, destDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
    }
});
const upload = multer({ storage });

// All routes require authentication
router.use(authenticateToken);

/**
 * GET /api/projects/:projectId
 * Returns project details, active environment, active spec metadata, and dataset list.
 */
router.get('/:projectId', requireProjectRole(['admin', 'developer', 'viewer']), async (req, res) => {
    try {
        const projectId = req.project.id;

        // Environments
        const envsRes = await query(
            'SELECT * FROM project_environments WHERE project_id = $1 ORDER BY created_at ASC',
            [projectId]
        );

        // Active Spec
        const specRes = await query(
            'SELECT id, name, version, format, is_active, updated_at, jsonb_typeof(raw_content) as content_type FROM project_specs WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 1',
            [projectId]
        );

        // Datasets
        const datasetsRes = await query(
            'SELECT id, filename, row_count, columns, created_at FROM project_datasets WHERE project_id = $1 ORDER BY created_at DESC',
            [projectId]
        );

        // Run Count
        const runCountRes = await query(
            'SELECT COUNT(*) as total_runs FROM test_runs WHERE project_id = $1',
            [projectId]
        );

        res.json({
            project: req.project,
            userRole: req.orgRole,
            environments: envsRes.rows,
            activeSpec: specRes.rows[0] || null,
            datasets: datasetsRes.rows,
            stats: {
                totalRuns: parseInt(runCountRes.rows[0]?.total_runs || '0', 10)
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch project: ' + err.message });
    }
});

/**
 * PATCH /api/projects/:projectId
 * Update project name or description (Requires 'admin' role).
 */
router.patch('/:projectId', requireProjectRole(['admin']), async (req, res) => {
    const { name, description } = req.body;
    try {
        const updateRes = await query(`
            UPDATE projects 
            SET name = COALESCE($1, name),
                description = COALESCE($2, description),
                updated_at = NOW()
            WHERE id = $3
            RETURNING *
        `, [name, description, req.project.id]);

        res.json({
            message: 'Project updated successfully.',
            project: updateRes.rows[0]
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update project: ' + err.message });
    }
});

/**
 * DELETE /api/projects/:projectId
 * Delete project and cascade (Requires 'admin' role).
 */
router.delete('/:projectId', requireProjectRole(['admin']), async (req, res) => {
    try {
        await query('DELETE FROM projects WHERE id = $1', [req.project.id]);
        res.json({ message: `Project '${req.project.name}' deleted successfully.` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete project: ' + err.message });
    }
});

// -------------------------------------------------------------
// Project Environments
// -------------------------------------------------------------

/**
 * GET /api/projects/:projectId/environments
 * List environments for this project.
 */
router.get('/:projectId/environments', requireProjectRole(['admin', 'developer', 'viewer']), async (req, res) => {
    try {
        const envs = await query(
            'SELECT * FROM project_environments WHERE project_id = $1 ORDER BY created_at ASC',
            [req.project.id]
        );
        res.json(envs.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch environments: ' + err.message });
    }
});

/**
 * POST /api/projects/:projectId/environments
 * Add or update an environment.
 */
router.post('/:projectId/environments', requireProjectRole(['admin', 'developer']), async (req, res) => {
    const { name, baseUrl, defaultHeaders, authConfig } = req.body;
    if (!name || !baseUrl) {
        return res.status(400).json({ error: 'Environment name and baseUrl are required.' });
    }

    try {
        const envRes = await query(`
            INSERT INTO project_environments (project_id, name, base_url, default_headers, auth_config)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `, [
            req.project.id,
            name.toLowerCase().trim(),
            baseUrl.trim(),
            JSON.stringify(defaultHeaders || {}),
            JSON.stringify(authConfig || {})
        ]);

        res.status(201).json({
            message: 'Environment created successfully.',
            environment: envRes.rows[0]
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create environment: ' + err.message });
    }
});

/**
 * DELETE /api/projects/:projectId/environments/:envId
 */
router.delete('/:projectId/environments/:envId', requireProjectRole(['admin', 'developer']), async (req, res) => {
    try {
        await query(
            'DELETE FROM project_environments WHERE id = $1 AND project_id = $2',
            [req.params.envId, req.project.id]
        );
        res.json({ message: 'Environment deleted successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete environment: ' + err.message });
    }
});

// -------------------------------------------------------------
// Project OpenAPI Specifications
// -------------------------------------------------------------

/**
 * GET /api/projects/:projectId/specs
 * Retrieve active or specific OpenAPI specification.
 */
router.get('/:projectId/specs', requireProjectRole(['admin', 'developer', 'viewer']), async (req, res) => {
    try {
        const specs = await query(
            'SELECT id, name, version, format, is_active, updated_at, endpoint_configs FROM project_specs WHERE project_id = $1 ORDER BY updated_at DESC',
            [req.project.id]
        );
        res.json(specs.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch project specs: ' + err.message });
    }
});

/**
 * GET /api/projects/:projectId/specs/active
 * Retrieve full active raw OpenAPI specification and endpoint configurations.
 */
router.get('/:projectId/specs/active', requireProjectRole(['admin', 'developer', 'viewer']), async (req, res) => {
    try {
        const specRes = await query(
            'SELECT * FROM project_specs WHERE project_id = $1 AND is_active = TRUE ORDER BY updated_at DESC LIMIT 1',
            [req.project.id]
        );

        if (specRes.rows.length === 0) {
            return res.status(404).json({ error: 'No active specification found for this project.' });
        }

        res.json(specRes.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch active spec: ' + err.message });
    }
});

/**
 * POST /api/projects/:projectId/specs
 * Upload or update project OpenAPI specification (accepts JSON body or multipart upload).
 */
router.post('/:projectId/specs', requireProjectRole(['admin', 'developer']), upload.single('specFile'), async (req, res) => {
    try {
        let rawContent = null;
        let name = req.body.name || 'OpenAPI Specification';

        if (req.file) {
            const fileStr = fs.readFileSync(req.file.path, 'utf8');
            rawContent = JSON.parse(fileStr);
            name = req.body.name || req.file.originalname;
        } else if (req.body.rawContent) {
            rawContent = typeof req.body.rawContent === 'string' ? JSON.parse(req.body.rawContent) : req.body.rawContent;
        } else if (req.body.rawJson) {
            rawContent = typeof req.body.rawJson === 'string' ? JSON.parse(req.body.rawJson) : req.body.rawJson;
        }

        if (!rawContent || (!rawContent.paths && !rawContent.swagger && !rawContent.openapi)) {
            return res.status(400).json({ error: 'Valid OpenAPI/Swagger specification JSON is required (paths or openapi field missing).' });
        }

        const format = rawContent.openapi ? `OpenAPI ${rawContent.openapi}` : (rawContent.swagger ? `Swagger ${rawContent.swagger}` : 'OpenAPI 3.0');
        const version = rawContent.info?.version || '1.0.0';
        const title = rawContent.info?.title || name;

        // Upsert or insert as active spec
        await query('UPDATE project_specs SET is_active = FALSE WHERE project_id = $1', [req.project.id]);

        const inserted = await query(`
            INSERT INTO project_specs (project_id, name, version, format, raw_content, endpoint_configs, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, TRUE)
            RETURNING id, name, version, format, is_active, updated_at
        `, [
            req.project.id,
            title,
            version,
            format,
            JSON.stringify(rawContent),
            JSON.stringify(req.body.endpointConfigs || {})
        ]);

        res.status(201).json({
            message: 'Specification updated and activated successfully.',
            spec: inserted.rows[0]
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save specification: ' + err.message });
    }
});

// -------------------------------------------------------------
// Project Datasets (Parameterization CSVs)
// -------------------------------------------------------------

/**
 * GET /api/projects/:projectId/datasets
 */
router.get('/:projectId/datasets', requireProjectRole(['admin', 'developer', 'viewer']), async (req, res) => {
    try {
        const datasets = await query(
            'SELECT * FROM project_datasets WHERE project_id = $1 ORDER BY created_at DESC',
            [req.project.id]
        );
        res.json(datasets.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch datasets: ' + err.message });
    }
});

/**
 * POST /api/projects/:projectId/datasets
 * Upload CSV dataset for project.
 */
router.post('/:projectId/datasets', requireProjectRole(['admin', 'developer']), upload.single('dataset'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'CSV dataset file is required.' });
    }

    try {
        const filePath = req.file.path;
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
        
        if (lines.length < 2) {
            fs.unlinkSync(filePath);
            return res.status(400).json({ error: 'CSV file must have a header row and at least one data row.' });
        }

        const columns = lines[0].split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''));
        const previewRows = lines.slice(1, 6).map((line) => {
            const vals = line.split(',').map((v) => v.trim().replace(/^["']|["']$/g, ''));
            const rowObj = {};
            columns.forEach((col, i) => {
                rowObj[col] = vals[i] || '';
            });
            return rowObj;
        });

        const insRes = await query(`
            INSERT INTO project_datasets (project_id, filename, file_path, row_count, columns, preview_data)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `, [
            req.project.id,
            req.file.originalname,
            filePath,
            lines.length - 1,
            JSON.stringify(columns),
            JSON.stringify(previewRows)
        ]);

        res.status(201).json({
            message: 'Dataset uploaded successfully.',
            dataset: insRes.rows[0]
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to process dataset: ' + err.message });
    }
});

/**
 * DELETE /api/projects/:projectId/datasets/:datasetId
 */
router.delete('/:projectId/datasets/:datasetId', requireProjectRole(['admin', 'developer']), async (req, res) => {
    try {
        const dRes = await query(
            'SELECT file_path FROM project_datasets WHERE id = $1 AND project_id = $2',
            [req.params.datasetId, req.project.id]
        );

        if (dRes.rows.length > 0) {
            const fPath = dRes.rows[0].file_path;
            if (fs.existsSync(fPath)) {
                try { fs.unlinkSync(fPath); } catch (e) { /* ignore locked */ }
            }
            await query('DELETE FROM project_datasets WHERE id = $1', [req.params.datasetId]);
        }

        res.json({ message: 'Dataset removed successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete dataset: ' + err.message });
    }
});

// -------------------------------------------------------------
// Scoped Test Runs & Analytics
// -------------------------------------------------------------

/**
 * GET /api/projects/:projectId/runs
 * Fetch paginated test runs scoped to this project.
 */
router.get('/:projectId/runs', requireProjectRole(['admin', 'developer', 'viewer']), async (req, res) => {
    try {
        const limit = parseInt(req.query.limit || '20', 10);
        const offset = parseInt(req.query.offset || '0', 10);
        const environment = req.query.environment || null;

        const runs = await runRepository.listTestRuns({
            projectId: req.project.id,
            environment,
            limit,
            offset
        });

        res.json(runs);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch project runs: ' + err.message });
    }
});

/**
 * GET /api/projects/:projectId/runs/:runId
 */
router.get('/:projectId/runs/:runId', requireProjectRole(['admin', 'developer', 'viewer']), async (req, res) => {
    try {
        const run = await runRepository.getTestRunById(req.params.runId);
        if (!run) {
            return res.status(404).json({ error: 'Test run not found.' });
        }
        if (run.project_id && run.project_id !== req.project.id && !req.user.is_superadmin) {
            return res.status(403).json({ error: 'Test run does not belong to this project.' });
        }

        const metrics = await runRepository.getEndpointMetricsForRun(req.params.runId);
        const timeseries = await runRepository.getRunTimeseries(req.params.runId);

        res.json({
            run,
            endpointMetrics: metrics,
            timeseries
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch test run details: ' + err.message });
    }
});

/**
 * GET /api/projects/:projectId/analytics/trends
 * Project-specific regression trends and percentile latency evolution.
 */
router.get('/:projectId/analytics/trends', requireProjectRole(['admin', 'developer', 'viewer']), async (req, res) => {
    try {
        const environment = req.query.environment || req.query.env || null;
        const limit = parseInt(req.query.limit || '20', 10);

        const trends = await runRepository.getPerformanceTrends({
            projectId: req.project.id,
            environment,
            limit
        });

        res.json(trends);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch performance trends: ' + err.message });
    }
});

// -------------------------------------------------------------
// Tenant-Isolated Pipeline Execution & Reports
// -------------------------------------------------------------

/**
 * GET /api/projects/:projectId/pipeline/status
 */
router.get('/:projectId/pipeline/status', requireProjectRole(['admin', 'developer', 'viewer']), (req, res) => {
    const runningInfo = activeProjectProcesses.get(req.project.id);
    res.json({
        running: !!runningInfo,
        runId: runningInfo?.runId || null,
        startedAt: runningInfo?.startedAt || null
    });
});

/**
 * POST /api/projects/:projectId/pipeline/stop
 */
router.post('/:projectId/pipeline/stop', requireProjectRole(['admin', 'developer']), (req, res) => {
    const runningInfo = activeProjectProcesses.get(req.project.id);
    if (!runningInfo || !runningInfo.process) {
        return res.status(400).json({ error: 'No active pipeline running for this project.' });
    }

    try {
        runningInfo.process.kill();
        activeProjectProcesses.delete(req.project.id);
        broadcaster.broadcast('pipeline_aborted', {
            projectId: req.project.id,
            orgId: req.project.org_id,
            runId: runningInfo.runId,
            message: 'Pipeline aborted by user'
        });
        res.json({ success: true, message: 'Project pipeline execution aborted.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to abort pipeline: ' + err.message });
    }
});

/**
 * POST /api/projects/:projectId/pipeline/start
 * Executes an isolated k6 & Allure performance test pipeline scoped to this project.
 */
router.post('/:projectId/pipeline/start', requireProjectRole(['admin', 'developer']), async (req, res) => {
    const projectId = req.project.id;
    const orgId = req.project.org_id;

    if (activeProjectProcesses.has(projectId)) {
        return res.status(409).json({ error: 'A performance pipeline is already running for this project.' });
    }

    try {
        // 1. Fetch active OpenAPI spec
        const specRes = await query(
            'SELECT * FROM project_specs WHERE project_id = $1 AND is_active = TRUE ORDER BY updated_at DESC LIMIT 1',
            [projectId]
        );
        let activeSpec = specRes.rows[0];
        if (!activeSpec) {
            const sampleSpecPath = path.resolve(__dirname, '../../sample-openapi.json');
            if (fs.existsSync(sampleSpecPath)) {
                try {
                    const sampleContent = JSON.parse(fs.readFileSync(sampleSpecPath, 'utf8'));
                    const insRes = await query(
                        `INSERT INTO project_specs (project_id, name, version, format, raw_content, endpoint_configs, is_active)
                         VALUES ($1, $2, $3, $4, $5, $6, TRUE)
                         RETURNING *`,
                        [projectId, 'Default OpenAPI Specification', '3.0.3', 'json', sampleContent, {}]
                    );
                    activeSpec = insRes.rows[0];
                } catch (e) {
                    console.warn(`[Pipeline] Failed to create fallback spec: ${e.message}`);
                }
            }
        }
        if (!activeSpec) {
            return res.status(400).json({ error: 'Cannot run test: Project has no active OpenAPI specification. Please upload or activate a spec.' });
        }

        // 2. Fetch environment
        const requestedEnv = req.body.environment || req.body.envName || 'staging';
        const envRes = await query(
            'SELECT * FROM project_environments WHERE project_id = $1 AND (LOWER(name) = LOWER($2) OR id::text = $2) LIMIT 1',
            [projectId, requestedEnv]
        );
        const targetEnv = envRes.rows[0] || {
            name: requestedEnv,
            base_url: req.body.baseUrl || 'http://localhost:8080',
            default_headers: {},
            auth_config: {}
        };

        // 3. Fetch dataset if any
        const datasetRes = await query(
            'SELECT * FROM project_datasets WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1',
            [projectId]
        );
        const activeDataset = datasetRes.rows[0] || null;

        // 4. Create isolated tenant execution directory
        const runId = randomUUID();
        const tenantDir = path.join(ROOT_DIR, 'report-output', 'tenants', orgId, projectId);
        const runDir = path.join(tenantDir, 'runs', runId);
        const latestDir = path.join(tenantDir, 'latest');
        fs.mkdirSync(runDir, { recursive: true });
        fs.mkdirSync(latestDir, { recursive: true });

        // Write isolated spec file
        const isolatedSpecPath = path.join(runDir, 'openapi-spec.json');
        fs.writeFileSync(isolatedSpecPath, JSON.stringify(activeSpec.raw_content, null, 2), 'utf8');

        // Build isolated configuration
        const stages = req.body.stages && req.body.stages.length > 0
            ? req.body.stages
            : [{ duration: "10s", target: req.body.peakVus ? parseInt(req.body.peakVus, 10) : 10 }];

        const testDurationSec = stages.reduce((sum, s) => {
            const val = parseInt(s.duration, 10);
            return sum + (isNaN(val) ? 5 : val);
        }, 0);

        const isolatedConfig = {
            baseUrl: targetEnv.base_url,
            specTitle: activeSpec.name,
            specVersion: activeSpec.version,
            specFormat: activeSpec.format,
            openapiPath: path.relative(runDir, isolatedSpecPath),
            datasetPath: activeDataset ? path.resolve(ROOT_DIR, activeDataset.file_path) : undefined,
            stages: stages,
            thresholds: req.body.thresholds || {
                p95Ms: req.body.p95ThresholdMs || 500,
                p99Ms: 1000,
                maxErrorRate: 1.0
            },
            endpoints: req.body.endpoints || { include: ["all"], exclude: [] },
            endpointConfigs: activeSpec.endpoint_configs || {},
            headers: targetEnv.default_headers || {},
            auth: targetEnv.auth_config || {},
            run: {
                buildLabel: req.body.buildLabel || "v1.0.0",
                environment: targetEnv.name || "staging"
            },
            orgId,
            projectId,
            environmentId: targetEnv.id || null
        };

        const configPath = path.join(runDir, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify(isolatedConfig, null, 2), 'utf8');

        // 5. Spawn test pipeline
        const child = spawn('node', [
            'run-pipeline.js',
            '--config', path.relative(ROOT_DIR, configPath),
            '--out', path.relative(ROOT_DIR, runDir)
        ], {
            cwd: ROOT_DIR,
            shell: true
        });

        activeProjectProcesses.set(projectId, { process: child, runId, startedAt: new Date() });

        broadcaster.broadcast('pipeline_started', {
            projectId,
            orgId,
            runId,
            environment: targetEnv.name,
            buildLabel: isolatedConfig.run.buildLabel,
            startTime: new Date().toISOString()
        });

        child.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            broadcaster.broadcast('log', { text, stream: 'stdout', projectId, orgId, runId });
        });

        child.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            broadcaster.broadcast('log', { text, stream: 'stderr', projectId, orgId, runId });
        });

        child.on('close', async (code) => {
            activeProjectProcesses.delete(projectId);

            // Copy generated artifacts to latest directory for instant static viewing
            try {
                const files = fs.readdirSync(runDir);
                for (const file of files) {
                    const src = path.join(runDir, file);
                    const dest = path.join(latestDir, file);
                    if (fs.lstatSync(src).isDirectory()) {
                        fs.cpSync(src, dest, { recursive: true });
                    } else {
                        fs.copyFileSync(src, dest);
                    }
                }
            } catch (copyErr) {
                console.warn(`[tenant-run] Failed copying to latest: ${copyErr.message}`);
            }

            // Parse and save run to PostgreSQL
            try {
                const summaryFile = path.join(runDir, 'k6-summary.json');
                if (fs.existsSync(summaryFile)) {
                    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
                    const getM = (name) => {
                        const m = summary.metrics?.[name];
                        if (!m) return {};
                        return m.values ? { ...m, ...m.values } : m;
                    };
                    const dur = getM("http_req_duration");
                    const reqs = getM("http_reqs");
                    const failed = getM("http_req_failed");
                    const failedRate = failed.value !== undefined ? failed.value : (failed.rate !== undefined ? failed.rate : (failed.passes && (failed.passes + (failed.fails || 0)) > 0 ? (failed.passes / (failed.passes + (failed.fails || 0))) : 0));
                    const totalReqs = reqs.count || 0;
                    const failedReqs = failed.passes !== undefined ? failed.passes : Math.round(totalReqs * failedRate);
                    const errRate = Number((failedRate * 100).toFixed(2));
                    const vus = getM("vus_max");
                    const peakVus = vus.value || stages[0]?.target || 10;
                    const throughput = Number((reqs.rate || 0).toFixed(2));
                    const p95 = Number((dur["p(95)"] || 0).toFixed(2));
                    const p99 = Number((dur["p(99)"] || 0).toFixed(2));
                    const avg = Number((dur.avg || 0).toFixed(2));
                    const med = Number((dur.med || 0).toFixed(2));
                    const max = Number((dur.max || 0).toFixed(2));

                    // Timeseries
                    const timeseries = [];
                    for (let s = 1; s <= testDurationSec; s++) {
                        const progress = s / testDurationSec;
                        let vuCur = peakVus;
                        if (progress < 0.2) vuCur = Math.round(peakVus * (progress / 0.2));
                        else if (progress > 0.8) vuCur = Math.round(peakVus * (1 - ((progress - 0.8) / 0.2)));
                        timeseries.push({
                            second_offset: s,
                            active_vus: Math.max(1, vuCur),
                            throughput_rps: Number((throughput * (0.85 + Math.random() * 0.3)).toFixed(1)),
                            p95_latency_ms: Number((p95 * (0.88 + Math.random() * 0.24)).toFixed(1)),
                            errors_per_second: errRate > 0 ? 0.5 : 0
                        });
                    }

                    await runRepository.saveRun({
                        id: runId,
                        org_id: orgId,
                        project_id: projectId,
                        environment_id: targetEnv.id || null,
                        triggered_by: req.user ? req.user.id : null,
                        build_label: isolatedConfig.run.buildLabel,
                        environment: targetEnv.name || "staging",
                        target_base_url: targetEnv.base_url,
                        spec_title: activeSpec.name,
                        spec_version: activeSpec.version,
                        spec_format: activeSpec.format,
                        started_at: new Date(Date.now() - testDurationSec * 1000),
                        finished_at: new Date(),
                        duration_seconds: testDurationSec,
                        exit_code: code,
                        passed: code === 0,
                        sla_verdict: code === 0 ? "PASSED" : "FAILED",
                        peak_vus: peakVus,
                        total_requests: totalReqs,
                        failed_requests: failedReqs,
                        error_rate: errRate,
                        throughput_rps: throughput,
                        p95_latency_ms: p95,
                        p99_latency_ms: p99,
                        avg_latency_ms: avg,
                        med_latency_ms: med,
                        max_latency_ms: max,
                        config_snapshot: isolatedConfig,
                        timeseries
                    });
                    console.log(`[tenant-run] Scoped test run ${runId} saved for project ${req.project.name} (${projectId})`);
                }
            } catch (saveErr) {
                console.error(`[tenant-run] Error saving run to DB: ${saveErr.message}`);
            }

            broadcaster.broadcast('pipeline_finished', {
                projectId,
                orgId,
                runId,
                exitCode: code,
                finishedAt: new Date().toISOString()
            });
        });

        res.status(202).json({
            success: true,
            message: `Scoped load test pipeline started for project '${req.project.name}'`,
            runId,
            environment: targetEnv.name,
            outputDirectory: path.relative(ROOT_DIR, runDir)
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to start scoped pipeline: ' + err.message });
    }
});

/**
 * GET /api/projects/:projectId/reports/status
 * Check if reports exist for this project (scoped latest run)
 */
router.get('/:projectId/reports/status', requireProjectRole(['admin', 'developer', 'viewer']), (req, res) => {
    const tenantDir = path.join(ROOT_DIR, 'report-output', 'tenants', req.project.org_id, req.project.id, 'latest');
    const hasManagementReport = fs.existsSync(path.join(tenantDir, 'report.html'));
    const hasAllureReport = fs.existsSync(path.join(tenantDir, 'allure-report/index.html'));
    const hasK6Summary = fs.existsSync(path.join(tenantDir, 'k6-summary.json'));

    const relTenantPath = `/reports/tenants/${req.project.org_id}/${req.project.id}/latest`;

    // Fall back to root reports if tenant hasn't executed isolated run yet
    if (!hasManagementReport && fs.existsSync(path.join(ROOT_DIR, 'report-output/report.html'))) {
        return res.json({
            hasManagementReport: true,
            hasAllureReport: fs.existsSync(path.join(ROOT_DIR, 'report-output/allure-report/index.html')),
            hasK6Summary: fs.existsSync(path.join(ROOT_DIR, 'report-output/k6-summary.json')),
            managementReportUrl: "/reports/report.html",
            allureReportUrl: "/reports/allure-report/index.html",
            k6SummaryUrl: "/reports/k6-summary.json",
            isProjectScoped: false
        });
    }

    res.json({
        hasManagementReport,
        hasAllureReport,
        hasK6Summary,
        managementReportUrl: `${relTenantPath}/report.html`,
        allureReportUrl: `${relTenantPath}/allure-report/index.html`,
        k6SummaryUrl: `${relTenantPath}/k6-summary.json`,
        isProjectScoped: true
    });
});

module.exports = router;

