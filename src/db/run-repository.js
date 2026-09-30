const db = require('./database');
const { randomUUID } = require('crypto');

/**
 * Persists a complete test execution run with metrics, timeseries data, and contract results into PostgreSQL.
 */
async function saveRun(runData) {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const runId = runData.id || runData.run_id || runData.runId || randomUUID();
        const buildLabel = runData.build_label || runData.buildLabel || 'v1.0.0';
        const environment = runData.environment || 'staging';
        const targetBaseUrl = runData.target_base_url || runData.targetBaseUrl || 'http://localhost:8080';
        const specTitle = runData.spec_title || runData.specTitle || 'OpenAPI Specification';
        const specVersion = runData.spec_version || runData.specVersion || '1.0.0';
        const specFormat = runData.spec_format || runData.specFormat || 'OpenAPI 3.0';
        const startedAt = runData.started_at || runData.startedAt || new Date();
        const finishedAt = runData.finished_at || runData.finishedAt || new Date();
        const durationSeconds = Number(runData.duration_seconds || runData.durationSeconds || 0);
        const exitCode = runData.exit_code !== undefined ? runData.exit_code : (runData.exitCode !== undefined ? runData.exitCode : 0);
        const passed = runData.passed !== undefined ? runData.passed : (exitCode === 0);
        const slaVerdict = runData.sla_verdict || runData.slaVerdict || (passed ? 'PASSED' : 'FAILED');
        const peakVus = Number(runData.peak_vus || runData.peakVus || 0);
        const totalRequests = Number(runData.total_requests || runData.totalRequests || 0);
        const failedRequests = Number(runData.failed_requests || runData.failedRequests || 0);
        const errorRate = Number(runData.error_rate !== undefined ? runData.error_rate : (runData.errorRate || 0));
        const throughputRps = Number(runData.throughput_rps !== undefined ? runData.throughput_rps : (runData.throughputRps || 0));
        const p95LatencyMs = Number(runData.p95_latency_ms !== undefined ? runData.p95_latency_ms : (runData.p95LatencyMs || 0));
        const p99LatencyMs = Number(runData.p99_latency_ms !== undefined ? runData.p99_latency_ms : (runData.p99LatencyMs || 0));
        const avgLatencyMs = Number(runData.avg_latency_ms !== undefined ? runData.avg_latency_ms : (runData.avgLatencyMs || 0));
        const medLatencyMs = Number(runData.med_latency_ms !== undefined ? runData.med_latency_ms : (runData.medLatencyMs || 0));
        const maxLatencyMs = Number(runData.max_latency_ms !== undefined ? runData.max_latency_ms : (runData.maxLatencyMs || 0));
        const configSnapshot = runData.config_snapshot || runData.configSnapshot || {};

        const orgId = runData.org_id || runData.orgId || null;
        const projectId = runData.project_id || runData.projectId || null;
        const environmentId = runData.environment_id || runData.environmentId || null;
        const rawTriggered = runData.triggered_by || runData.triggeredBy || null;
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const triggeredBy = (rawTriggered && uuidRegex.test(rawTriggered)) ? rawTriggered : null;

        const sampleTraces = runData.sample_traces || runData.sampleTraces || [];
        const apmProvider = runData.apm_provider || runData.apmProvider || 'generic';
        const apmUrlTemplate = runData.apm_url_template || runData.apmUrlTemplate || 'http://localhost:16686/trace/{traceId}';

        let finalOrgId = orgId;
        let finalProjectId = projectId;
        if (!finalOrgId || !finalProjectId) {
            const defaultProj = await client.query("SELECT id, org_id FROM projects WHERE slug = 'ecommerce-storefront' LIMIT 1");
            if (defaultProj.rows.length > 0) {
                if (!finalProjectId) finalProjectId = defaultProj.rows[0].id;
                if (!finalOrgId) finalOrgId = defaultProj.rows[0].org_id;
            }
        }

        // 1. Insert into test_runs
        const insertRunQuery = `
            INSERT INTO test_runs (
                id, build_label, environment, target_base_url,
                spec_title, spec_version, spec_format,
                started_at, finished_at, duration_seconds, exit_code,
                passed, sla_verdict, peak_vus, total_requests,
                failed_requests, error_rate, throughput_rps,
                p95_latency_ms, p99_latency_ms, avg_latency_ms,
                med_latency_ms, max_latency_ms, config_snapshot,
                org_id, project_id, environment_id, triggered_by,
                sample_traces, apm_provider, apm_url_template
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
                $25, $26, $27, $28, $29, $30, $31
            )
            RETURNING *
        `;

        const runResult = await client.query(insertRunQuery, [
            runId, buildLabel, environment, targetBaseUrl,
            specTitle, specVersion, specFormat,
            startedAt, finishedAt, durationSeconds, exitCode,
            passed, slaVerdict, peakVus, totalRequests,
            failedRequests, errorRate, throughputRps,
            p95LatencyMs, p99LatencyMs, avgLatencyMs,
            medLatencyMs, maxLatencyMs, JSON.stringify(configSnapshot),
            finalOrgId, finalProjectId, environmentId, triggeredBy,
            JSON.stringify(sampleTraces), apmProvider, apmUrlTemplate
        ]);

        const savedRun = runResult.rows[0];

        // 2. Insert endpoint run metrics
        const endpoints = runData.endpoints || [];
        for (const ep of endpoints) {
            await client.query(`
                INSERT INTO endpoint_run_metrics (
                    run_id, op_id, method, route, tag,
                    request_count, failure_count, error_rate,
                    p90_ms, p95_ms, p99_ms, avg_ms, min_ms, max_ms,
                    threshold_breached, expected_status_codes
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            `, [
                runId,
                ep.op_id || ep.opId || `${ep.method}_${ep.route}`,
                ep.method || 'GET',
                ep.route || '/',
                ep.tag || 'General',
                Number(ep.request_count || ep.requestCount || 0),
                Number(ep.failure_count || ep.failureCount || 0),
                Number(ep.error_rate !== undefined ? ep.error_rate : (ep.errorRate || 0)),
                Number(ep.p90_ms !== undefined ? ep.p90_ms : (ep.p90Ms || 0)),
                Number(ep.p95_ms !== undefined ? ep.p95_ms : (ep.p95Ms || 0)),
                Number(ep.p99_ms !== undefined ? ep.p99_ms : (ep.p99Ms || 0)),
                Number(ep.avg_ms !== undefined ? ep.avg_ms : (ep.avgMs || 0)),
                Number(ep.min_ms !== undefined ? ep.min_ms : (ep.minMs || 0)),
                Number(ep.max_ms !== undefined ? ep.max_ms : (ep.maxMs || 0)),
                Boolean(ep.threshold_breached || ep.thresholdBreached || false),
                ep.expected_status_codes || ep.expectedStatusCodes || [200]
            ]);
        }

        // 3. Insert timeseries datapoints
        const timeseries = runData.timeseries || [];
        if (timeseries.length > 0) {
            for (const pt of timeseries) {
                await client.query(`
                    INSERT INTO run_timeseries (
                        run_id, second_offset, active_vus, throughput_rps, p95_latency_ms, errors_per_second
                    ) VALUES ($1, $2, $3, $4, $5, $6)
                `, [
                    runId,
                    pt.second_offset !== undefined ? pt.second_offset : pt.secondOffset,
                    pt.active_vus !== undefined ? pt.active_vus : (pt.activeVus || 0),
                    Number(pt.throughput_rps !== undefined ? pt.throughput_rps : (pt.throughputRps || 0)),
                    Number(pt.p95_latency_ms !== undefined ? pt.p95_latency_ms : (pt.p95LatencyMs || 0)),
                    Number(pt.errors_per_second !== undefined ? pt.errors_per_second : (pt.errorsPerSecond || 0))
                ]);
            }
        }

        // 4. Insert contract test results
        const contractResults = runData.contract_results || runData.contractResults || [];
        for (const cr of contractResults) {
            await client.query(`
                INSERT INTO contract_test_results (
                    run_id, endpoint, method, check_name, status,
                    failure_reason, reproduction_curl, violation_details
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [
                runId,
                cr.endpoint || '/',
                cr.method || 'GET',
                cr.check_name || cr.checkName || 'Contract Check',
                cr.status || 'PASS',
                cr.failure_reason || cr.failureReason || null,
                cr.reproduction_curl || cr.reproductionCurl || null,
                cr.violation_details ? JSON.stringify(cr.violation_details) : null
            ]);
        }

        await client.query('COMMIT');
        return savedRun;
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[RunRepository] Error saving run to DB:', err);
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Retrieves a paginated list of test runs, optionally scoped by project/org/environment.
 */
async function getRuns({ limit = 30, offset = 0, environment = null, projectId = null, orgId = null } = {}) {
    let queryText = `
        SELECT 
            r.*,
            (SELECT COUNT(*) FROM endpoint_run_metrics WHERE run_id = r.id) as endpoint_count,
            (SELECT COUNT(*) FROM contract_test_results WHERE run_id = r.id AND status = 'FAIL') as contract_failures
        FROM test_runs r
    `;
    const params = [];
    const whereClauses = [];

    if (projectId) {
        params.push(projectId);
        whereClauses.push(`r.project_id = $${params.length}`);
    }

    if (orgId) {
        params.push(orgId);
        whereClauses.push(`r.org_id = $${params.length}`);
    }

    if (environment && environment !== 'all') {
        params.push(environment);
        whereClauses.push(`r.environment = $${params.length}`);
    }

    if (whereClauses.length > 0) {
        queryText += ` WHERE ` + whereClauses.join(' AND ');
    }

    queryText += ` ORDER BY r.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    let totalCountQuery = `SELECT COUNT(*) FROM test_runs r`;
    const countParams = [];
    const countWhere = [];
    if (projectId) {
        countParams.push(projectId);
        countWhere.push(`r.project_id = $${countParams.length}`);
    }
    if (orgId) {
        countParams.push(orgId);
        countWhere.push(`r.org_id = $${countParams.length}`);
    }
    if (environment && environment !== 'all') {
        countParams.push(environment);
        countWhere.push(`r.environment = $${countParams.length}`);
    }
    if (countWhere.length > 0) {
        totalCountQuery += ` WHERE ` + countWhere.join(' AND ');
    }

    const [listRes, countRes] = await Promise.all([
        db.query(queryText, params),
        db.query(totalCountQuery, countParams)
    ]);

    return {
        runs: listRes.rows,
        total: parseInt(countRes.rows[0]?.count || 0, 10),
        limit,
        offset
    };
}

/**
 * Retrieves a single test run by UUID or run_number.
 */
async function getRunById(idOrNumber) {
    let runRes;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrNumber);

    if (isUuid) {
        runRes = await db.query('SELECT * FROM test_runs WHERE id = $1', [idOrNumber]);
    } else {
        runRes = await db.query('SELECT * FROM test_runs WHERE run_number = $1', [parseInt(idOrNumber, 10)]);
    }

    if (runRes.rows.length === 0) {
        return null;
    }

    const run = runRes.rows[0];
    const runId = run.id;

    // Fetch endpoints, contract results, and point count
    const [endpointsRes, contractRes, tsCountRes] = await Promise.all([
        db.query('SELECT * FROM endpoint_run_metrics WHERE run_id = $1 ORDER BY p95_ms DESC', [runId]),
        db.query('SELECT * FROM contract_test_results WHERE run_id = $1', [runId]),
        db.query('SELECT COUNT(*) FROM run_timeseries WHERE run_id = $1', [runId])
    ]);

    run.endpoints = endpointsRes.rows;
    run.contract_results = contractRes.rows;
    run.timeseries_point_count = parseInt(tsCountRes.rows[0]?.count || 0, 10);

    return run;
}

/**
 * Retrieves endpoint run metrics for a run.
 */
async function getEndpointMetricsForRun(runId) {
    const res = await db.query('SELECT * FROM endpoint_run_metrics WHERE run_id = $1 ORDER BY p95_ms DESC', [runId]);
    return res.rows;
}

/**
 * Retrieves second-by-second timeseries points for charting.
 */
async function getRunTimeseries(runId) {
    const res = await db.query(`
        SELECT second_offset, active_vus, throughput_rps, p95_latency_ms, errors_per_second
        FROM run_timeseries
        WHERE run_id = $1
        ORDER BY second_offset ASC
    `, [runId]);
    return res.rows;
}

/**
 * Retrieves regression analytics and performance trends across releases/builds.
 */
async function getPerformanceTrends({ environment = null, limit = 15, projectId = null, orgId = null } = {}) {
    let queryText = `
        SELECT 
            id, run_number, build_label, environment,
            started_at, duration_seconds, passed, sla_verdict,
            peak_vus, total_requests, failed_requests, error_rate,
            throughput_rps, p95_latency_ms, p99_latency_ms, avg_latency_ms,
            (SELECT COUNT(*) FROM contract_test_results WHERE run_id = test_runs.id AND status = 'FAIL') as contract_fails
        FROM test_runs
    `;
    const params = [];
    const whereClauses = [];

    if (projectId) {
        params.push(projectId);
        whereClauses.push(`project_id = $${params.length}`);
    }

    if (orgId) {
        params.push(orgId);
        whereClauses.push(`org_id = $${params.length}`);
    }

    if (environment && environment !== 'all') {
        params.push(environment);
        whereClauses.push(`environment = $${params.length}`);
    }

    if (whereClauses.length > 0) {
        queryText += ` WHERE ` + whereClauses.join(' AND ');
    }

    queryText += ` ORDER BY started_at ASC LIMIT $${params.length + 1}`;
    params.push(limit);

    const res = await db.query(queryText, params);
    return res.rows;
}

module.exports = {
    saveRun,
    getRuns,
    listTestRuns: getRuns,
    getRunById,
    getTestRunById: getRunById,
    getEndpointMetricsForRun,
    getRunTimeseries,
    getPerformanceTrends
};
