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
const {
    startProjectPipeline,
    stopProjectPipeline,
    isProjectPipelineRunning,
    getProjectPipelineInfo
} = require('../execution/project-executor');
const {
    registerSchedule,
    unregisterSchedule,
    executeScheduledRun
} = require('../scheduler/cron-scheduler');

const ROOT_DIR = path.resolve(__dirname, '../../');
const DATA_DIR = path.join(ROOT_DIR, 'data/tenants');

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
 * Add or create an environment with optional APM & Distributed Tracing settings.
 */
router.post('/:projectId/environments', requireProjectRole(['admin', 'developer']), async (req, res) => {
    const { name, baseUrl, defaultHeaders, authConfig, tracingEnabled, apmProvider, apmUrlTemplate } = req.body;
    if (!name || !baseUrl) {
        return res.status(400).json({ error: 'Environment name and baseUrl are required.' });
    }

    try {
        const envRes = await query(`
            INSERT INTO project_environments (
                project_id, name, base_url, default_headers, auth_config,
                tracing_enabled, apm_provider, apm_url_template
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
        `, [
            req.project.id,
            name.toLowerCase().trim(),
            baseUrl.trim(),
            JSON.stringify(defaultHeaders || {}),
            JSON.stringify(authConfig || {}),
            tracingEnabled !== undefined ? Boolean(tracingEnabled) : true,
            apmProvider || 'generic',
            apmUrlTemplate || 'http://localhost:16686/trace/{traceId}'
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
 * PATCH /api/projects/:projectId/environments/:envId
 * Update environment settings, including base URL, headers, and APM tracing options.
 */
router.patch('/:projectId/environments/:envId', requireProjectRole(['admin', 'developer']), async (req, res) => {
    const { baseUrl, defaultHeaders, authConfig, tracingEnabled, apmProvider, apmUrlTemplate } = req.body;
    try {
        const updateRes = await query(`
            UPDATE project_environments
            SET base_url = COALESCE($1, base_url),
                default_headers = COALESCE($2, default_headers),
                auth_config = COALESCE($3, auth_config),
                tracing_enabled = COALESCE($4, tracing_enabled),
                apm_provider = COALESCE($5, apm_provider),
                apm_url_template = COALESCE($6, apm_url_template)
            WHERE id = $7 AND project_id = $8
            RETURNING *
        `, [
            baseUrl ? baseUrl.trim() : null,
            defaultHeaders ? JSON.stringify(defaultHeaders) : null,
            authConfig ? JSON.stringify(authConfig) : null,
            tracingEnabled !== undefined ? Boolean(tracingEnabled) : null,
            apmProvider || null,
            apmUrlTemplate || null,
            req.params.envId,
            req.project.id
        ]);

        if (updateRes.rows.length === 0) {
            return res.status(404).json({ error: 'Environment not found.' });
        }

        res.json({
            message: 'Environment updated successfully.',
            environment: updateRes.rows[0]
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update environment: ' + err.message });
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
    const info = getProjectPipelineInfo(req.project.id);
    res.json({
        running: !!info,
        runId: info?.runId || null,
        startedAt: info?.startedAt || null
    });
});

/**
 * POST /api/projects/:projectId/pipeline/stop
 */
router.post('/:projectId/pipeline/stop', requireProjectRole(['admin', 'developer']), (req, res) => {
    const stopped = stopProjectPipeline(req.project.id);
    if (!stopped) {
        return res.status(400).json({ error: 'No active performance pipeline running for this project.' });
    }
    res.json({ success: true, message: 'Project pipeline execution aborted.' });
});

/**
 * POST /api/projects/:projectId/pipeline/start
 * Executes an isolated k6 & Allure performance test pipeline scoped to this project.
 */
router.post('/:projectId/pipeline/start', requireProjectRole(['admin', 'developer']), async (req, res) => {
    try {
        const result = await startProjectPipeline({
            projectId: req.project.id,
            orgId: req.project.org_id,
            environmentName: req.body.environment || req.body.envName || 'staging',
            baseUrl: req.body.baseUrl,
            stages: req.body.stages,
            peakVus: req.body.peakVus,
            thresholds: req.body.thresholds,
            p95ThresholdMs: req.body.p95ThresholdMs,
            maxErrorRate: req.body.maxErrorRate,
            maxFailuresToStop: req.body.maxFailuresToStop,
            buildLabel: req.body.buildLabel || 'v1.0.0',
            triggeredBy: req.user.id
        });

        res.status(202).json({
            success: true,
            message: `Scoped load test pipeline started for project '${req.project.name}'`,
            runId: result.runId,
            environment: result.targetEnvironment,
            outputDirectory: path.relative(ROOT_DIR, result.outputDirectory)
        });
    } catch (err) {
        if (err.message && err.message.includes('already running')) {
            return res.status(409).json({ error: err.message });
        }
        res.status(400).json({ error: err.message });
    }
});

// ==========================================
// SCHEDULES (Automated Cron Benchmarks)
// ==========================================

// GET /api/projects/:projectId/schedules
router.get('/:projectId/schedules', requireProjectRole(['admin', 'developer', 'viewer']), async (req, res) => {
    try {
        const schRes = await query(
            `SELECT s.*, e.name as environment_name, u.full_name as creator_name
             FROM project_schedules s
             LEFT JOIN project_environments e ON s.environment_id = e.id
             LEFT JOIN users u ON s.created_by = u.id
             WHERE s.project_id = $1
             ORDER BY s.created_at DESC`,
            [req.project.id]
        );
        res.json(schRes.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed fetching schedules: ' + err.message });
    }
});

// POST /api/projects/:projectId/schedules
router.post('/:projectId/schedules', requireProjectRole(['admin', 'developer']), async (req, res) => {
    try {
        const { name, cronExpression, environmentId, peakVus, durationSec, p95ThresholdMs, maxErrorRatePct } = req.body;
        if (!name || !cronExpression) {
            return res.status(400).json({ error: 'Name and cronExpression are required.' });
        }

        const cron = require('node-cron');
        if (!cron.validate(cronExpression.trim())) {
            return res.status(400).json({ error: `Invalid cron expression '${cronExpression}'. Example: '0 2 * * *' (Every day at 2 AM)` });
        }

        const insRes = await query(
            `INSERT INTO project_schedules 
             (project_id, environment_id, name, cron_expression, is_active, peak_vus, duration_sec, p95_threshold_ms, max_error_rate_pct, created_by)
             VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7, $8, $9)
             RETURNING *`,
            [
                req.project.id,
                environmentId || null,
                name.trim(),
                cronExpression.trim(),
                peakVus ? parseInt(peakVus, 10) : 20,
                durationSec ? parseInt(durationSec, 10) : 10,
                p95ThresholdMs ? parseInt(p95ThresholdMs, 10) : 500,
                maxErrorRatePct !== undefined ? parseFloat(maxErrorRatePct) : 1.0,
                req.user.id
            ]
        );
        const newSchedule = insRes.rows[0];
        registerSchedule(newSchedule);

        res.status(201).json({ success: true, schedule: newSchedule });
    } catch (err) {
        res.status(500).json({ error: 'Failed creating schedule: ' + err.message });
    }
});

// PUT /api/projects/:projectId/schedules/:scheduleId
router.put('/:projectId/schedules/:scheduleId', requireProjectRole(['admin', 'developer']), async (req, res) => {
    try {
        const { scheduleId } = req.params;
        const { name, cronExpression, environmentId, peakVus, durationSec, p95ThresholdMs, maxErrorRatePct, isActive } = req.body;

        const curRes = await query('SELECT * FROM project_schedules WHERE id = $1 AND project_id = $2', [scheduleId, req.project.id]);
        if (curRes.rows.length === 0) {
            return res.status(404).json({ error: 'Schedule not found.' });
        }
        const current = curRes.rows[0];

        const updatedCron = cronExpression !== undefined ? cronExpression.trim() : current.cron_expression;
        const cron = require('node-cron');
        if (cronExpression !== undefined && !cron.validate(updatedCron)) {
            return res.status(400).json({ error: `Invalid cron expression '${updatedCron}'` });
        }

        const updatedActive = isActive !== undefined ? !!isActive : current.is_active;

        const updRes = await query(
            `UPDATE project_schedules
             SET name = COALESCE($1, name),
                 cron_expression = $2,
                 environment_id = COALESCE($3, environment_id),
                 peak_vus = COALESCE($4, peak_vus),
                 duration_sec = COALESCE($5, duration_sec),
                 p95_threshold_ms = COALESCE($6, p95_threshold_ms),
                 max_error_rate_pct = COALESCE($7, max_error_rate_pct),
                 is_active = $8,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $9 AND project_id = $10
             RETURNING *`,
            [
                name ? name.trim() : null,
                updatedCron,
                environmentId || null,
                peakVus ? parseInt(peakVus, 10) : null,
                durationSec ? parseInt(durationSec, 10) : null,
                p95ThresholdMs ? parseInt(p95ThresholdMs, 10) : null,
                maxErrorRatePct !== undefined ? parseFloat(maxErrorRatePct) : null,
                updatedActive,
                scheduleId,
                req.project.id
            ]
        );

        const updated = updRes.rows[0];
        if (updated.is_active) {
            registerSchedule(updated);
        } else {
            unregisterSchedule(updated.id);
        }

        res.json({ success: true, schedule: updated });
    } catch (err) {
        res.status(500).json({ error: 'Failed updating schedule: ' + err.message });
    }
});

// DELETE /api/projects/:projectId/schedules/:scheduleId
router.delete('/:projectId/schedules/:scheduleId', requireProjectRole(['admin', 'developer']), async (req, res) => {
    try {
        const { scheduleId } = req.params;
        unregisterSchedule(scheduleId);
        await query('DELETE FROM project_schedules WHERE id = $1 AND project_id = $2', [scheduleId, req.project.id]);
        res.json({ success: true, message: 'Schedule removed.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed deleting schedule: ' + err.message });
    }
});

// POST /api/projects/:projectId/schedules/:scheduleId/trigger
router.post('/:projectId/schedules/:scheduleId/trigger', requireProjectRole(['admin', 'developer']), async (req, res) => {
    try {
        const { scheduleId } = req.params;
        const curRes = await query('SELECT * FROM project_schedules WHERE id = $1 AND project_id = $2', [scheduleId, req.project.id]);
        if (curRes.rows.length === 0) {
            return res.status(404).json({ error: 'Schedule not found.' });
        }
        if (isProjectPipelineRunning(req.project.id)) {
            return res.status(409).json({ error: 'A performance pipeline is already running for this project.' });
        }

        // Trigger asynchronously
        executeScheduledRun(scheduleId);
        res.json({ success: true, message: `Scheduled benchmark '${curRes.rows[0].name}' triggered successfully.` });
    } catch (err) {
        res.status(500).json({ error: 'Failed triggering schedule: ' + err.message });
    }
});

// ==========================================
// WEBHOOKS (Alerts & Notifications)
// ==========================================

// GET /api/projects/:projectId/webhooks
router.get('/:projectId/webhooks', requireProjectRole(['admin', 'developer', 'viewer']), async (req, res) => {
    try {
        const whRes = await query(
            'SELECT id, project_id, name, url, events, is_active, last_dispatched_at, last_status_code, created_at FROM project_webhooks WHERE project_id = $1 ORDER BY created_at DESC',
            [req.project.id]
        );
        res.json(whRes.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed fetching webhooks: ' + err.message });
    }
});

// POST /api/projects/:projectId/webhooks
router.post('/:projectId/webhooks', requireProjectRole(['admin']), async (req, res) => {
    try {
        const { name, url, events, secret } = req.body;
        if (!url) {
            return res.status(400).json({ error: 'Webhook URL is required.' });
        }
        try {
            new URL(url);
        } catch (_) {
            return res.status(400).json({ error: 'Invalid URL format.' });
        }

        const eventsArray = Array.isArray(events) && events.length > 0 ? events : ['run.completed', 'sla.failed'];

        const insRes = await query(
            `INSERT INTO project_webhooks (project_id, name, url, events, secret, is_active)
             VALUES ($1, $2, $3, $4, $5, TRUE)
             RETURNING id, project_id, name, url, events, is_active, created_at`,
            [req.project.id, name ? name.trim() : 'Webhook Alert', url.trim(), JSON.stringify(eventsArray), secret ? secret.trim() : null]
        );

        res.status(201).json({ success: true, webhook: insRes.rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'Failed creating webhook: ' + err.message });
    }
});

// DELETE /api/projects/:projectId/webhooks/:webhookId
router.delete('/:projectId/webhooks/:webhookId', requireProjectRole(['admin']), async (req, res) => {
    try {
        const { webhookId } = req.params;
        await query('DELETE FROM project_webhooks WHERE id = $1 AND project_id = $2', [webhookId, req.project.id]);
        res.json({ success: true, message: 'Webhook removed.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed deleting webhook: ' + err.message });
    }
});

// POST /api/projects/:projectId/webhooks/test
router.post('/:projectId/webhooks/test', requireProjectRole(['admin', 'developer']), async (req, res) => {
    try {
        const { url, secret } = req.body;
        if (!url) return res.status(400).json({ error: 'URL is required.' });
        const { testWebhookPing } = require('../notifications/webhook-dispatcher');
        const outcome = await testWebhookPing(url, secret);
        res.json(outcome);
    } catch (err) {
        res.status(500).json({ error: 'Failed testing webhook: ' + err.message });
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

