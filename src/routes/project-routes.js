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

module.exports = router;
