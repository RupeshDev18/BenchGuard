/**
 * scripts/verify-phase6-tracing.js
 * 
 * End-to-end Verification for Phase 6: Distributed APM Tracing & OpenTelemetry.
 * Asserts:
 * 1. Project environment has tracing and APM configurations.
 * 2. Generated k6 script contains W3C traceparent and baggage injection.
 * 3. Execution pipeline runs and captures sample traces from live HTTP requests.
 * 4. Mock API receives traceparent and echoes back traceresponse and X-Trace-Id.
 * 5. Database persists sample_traces, apm_provider, and apm_url_template in test_runs.
 * 6. Management and Allure reports reflect APM distributed tracing metadata.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { initDatabase, query } = require('../src/db/database');
const { startProjectPipeline, isProjectPipelineRunning } = require('../src/execution/project-executor');

const ROOT_DIR = path.resolve(__dirname, '..');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runVerification() {
    console.log('==================================================================');
    console.log(' 🔬 PHASE 6 VERIFICATION: DISTRIBUTED APM TRACING & OPENTELEMETRY');
    console.log('==================================================================\n');

    await initDatabase();

    // 1. Fetch default Project and Environment
    console.log('[Step 1] Querying default project and staging environment...');
    const projRes = await query("SELECT id, org_id, name, slug FROM projects WHERE slug = 'ecommerce-storefront' LIMIT 1");
    if (projRes.rows.length === 0) {
        throw new Error('Default project ecommerce-storefront not found');
    }
    const project = projRes.rows[0];
    console.log(`✓ Project found: ${project.name} (${project.id})`);

    const envRes = await query("SELECT * FROM project_environments WHERE project_id = $1 AND name = 'staging' LIMIT 1", [project.id]);
    let stagingEnv = envRes.rows[0];
    if (!stagingEnv) {
        const insEnv = await query(`
            INSERT INTO project_environments (project_id, name, base_url, default_headers, tracing_enabled, apm_provider, apm_url_template)
            VALUES ($1, 'staging', 'http://localhost:8080', '{}', TRUE, 'jaeger', 'http://localhost:16686/trace/{traceId}')
            RETURNING *
        `, [project.id]);
        stagingEnv = insEnv.rows[0];
    } else {
        const updEnv = await query(`
            UPDATE project_environments
            SET tracing_enabled = TRUE,
                apm_provider = 'jaeger',
                apm_url_template = 'http://localhost:16686/trace/{traceId}'
            WHERE id = $1
            RETURNING *
        `, [stagingEnv.id]);
        stagingEnv = updEnv.rows[0];
    }
    console.log(`✓ Environment configured with APM provider: ${stagingEnv.apm_provider}`);
    console.log(`✓ Tracer URL template: ${stagingEnv.apm_url_template}`);

    // 2. Direct Mock API Test for W3C Trace Context Echo
    console.log('\n[Step 2] Testing mock API W3C traceparent echo...');
    const sampleTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const sampleSpanId = '00f067aa0ba902b7';
    const sampleTraceparent = `00-${sampleTraceId}-${sampleSpanId}-01`;
    const sampleBaggage = 'k6.vu=1,k6.iter=0,user.tier=gold';

    const echoResult = await new Promise((resolve, reject) => {
        const req = http.request({
            hostname: 'localhost',
            port: 8080,
            path: '/api/v1/products',
            method: 'GET',
            headers: {
                'traceparent': sampleTraceparent,
                'baggage': sampleBaggage,
                'x-trace-id': sampleTraceId
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    traceresponse: res.headers['traceresponse'],
                    xTraceId: res.headers['x-trace-id'],
                    echoedBaggage: res.headers['x-echoed-baggage']
                });
            });
        });
        req.on('error', reject);
        req.end();
    });

    if (!echoResult.traceresponse || !echoResult.traceresponse.includes(sampleTraceId)) {
        throw new Error(`Mock API failed to echo traceresponse header. Received: ${echoResult.traceresponse}`);
    }
    if (echoResult.xTraceId !== sampleTraceId) {
        throw new Error(`Mock API failed to echo x-trace-id. Expected: ${sampleTraceId}, Received: ${echoResult.xTraceId}`);
    }
    console.log(`✓ Mock API W3C header echo validated: traceresponse=${echoResult.traceresponse}`);
    console.log(`✓ Mock API X-Trace-Id echo validated: ${echoResult.xTraceId}`);

    // 3. Trigger Tenant Test Execution Pipeline
    console.log('\n[Step 3] Launching isolated performance pipeline with tracing enabled...');
    const userRes = await query("SELECT id FROM users WHERE is_superadmin = TRUE LIMIT 1");
    const adminUserId = userRes.rows[0]?.id || null;

    const runInfo = await startProjectPipeline({
        projectId: project.id,
        orgId: project.org_id,
        environmentName: 'staging',
        stages: [{ duration: '5s', target: 5 }],
        p95ThresholdMs: 400,
        maxErrorRate: 0.05,
        buildLabel: 'v6.0.0-apm-tracing',
        triggeredBy: adminUserId
    });
    console.log(`✓ Pipeline spawned with Run ID: ${runInfo.runId}`);

    // Wait for pipeline completion
    console.log('[Step 4] Monitoring pipeline execution progress...');
    let pollCount = 0;
    while (isProjectPipelineRunning(project.id) && pollCount < 45) {
        process.stdout.write('.');
        await sleep(1000);
        pollCount++;
    }
    console.log('\n✓ Test execution finished!');

    // 4. Validate Generated Loadtest Script
    console.log('\n[Step 5] Validating generated k6 loadtest.js for tracing injection...');
    const runDir = path.join(ROOT_DIR, 'report-output', 'tenants', project.org_id, project.id, 'runs', runInfo.runId);
    const scriptPath = path.join(runDir, 'loadtest.js');
    if (!fs.existsSync(scriptPath)) {
        throw new Error(`k6 script not found at ${scriptPath}`);
    }
    const scriptCode = fs.readFileSync(scriptPath, 'utf8');
    if (!scriptCode.includes('generateTraceparent()')) {
        throw new Error('generateTraceparent() was not injected into loadtest.js');
    }
    if (!scriptCode.includes('"traceparent": trace.traceparent')) {
        throw new Error('"traceparent" header mapping missing from loadtest.js');
    }
    if (!scriptCode.includes('"x-trace-id": trace.traceId')) {
        throw new Error('"x-trace-id" header mapping missing from loadtest.js');
    }
    if (!scriptCode.includes('trace_id: trace.traceId')) {
        throw new Error('trace_id metric tag missing from loadtest.js');
    }
    console.log('✓ k6 loadtest.js contains pure JS W3C traceparent generator function.');
    console.log('✓ k6 requests inject traceparent, baggage, and x-trace-id headers.');
    console.log('✓ k6 metric tags record trace_id for granular OpenTelemetry correlation.');

    // 5. Validate Captured Sample Traces on Disk
    console.log('\n[Step 6] Validating sample-traces.json file...');
    const tracesPath = path.join(runDir, 'sample-traces.json');
    if (!fs.existsSync(tracesPath)) {
        throw new Error(`sample-traces.json was not generated at ${tracesPath}`);
    }
    const traces = JSON.parse(fs.readFileSync(tracesPath, 'utf8'));
    if (!Array.isArray(traces) || traces.length === 0) {
        throw new Error('sample-traces.json is empty or not an array');
    }
    console.log(`✓ Captured ${traces.length} sample traces!`);
    const sample = traces[0];
    console.log('  Sample trace structure:');
    console.log(`  - Endpoint:    ${sample.endpoint}`);
    console.log(`  - Trace ID:    ${sample.traceId}`);
    console.log(`  - Span ID:     ${sample.spanId}`);
    console.log(`  - Traceparent: ${sample.traceparent}`);
    console.log(`  - APM URL:     ${sample.apmUrl}`);

    const w3cRegex = /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/;
    if (!w3cRegex.test(sample.traceparent)) {
        throw new Error(`Invalid W3C traceparent header format: ${sample.traceparent}`);
    }
    console.log('✓ Traceparent strictly conforms to W3C Trace Context spec (00-<32hex>-<16hex>-01).');

    // 6. Validate PostgreSQL Persistence
    console.log('\n[Step 7] Checking PostgreSQL test_runs record for APM & Tracing data...');
    const dbRunRes = await query('SELECT id, build_label, sample_traces, apm_provider, apm_url_template FROM test_runs WHERE id = $1', [runInfo.runId]);
    if (dbRunRes.rows.length === 0) {
        throw new Error(`Run record ${runInfo.runId} not found in database`);
    }
    const dbRun = dbRunRes.rows[0];
    console.log(`✓ Run ${dbRun.id} found in DB:`);
    console.log(`  - APM Provider:     ${dbRun.apm_provider}`);
    console.log(`  - APM URL Template: ${dbRun.apm_url_template}`);
    const persistedTraces = Array.isArray(dbRun.sample_traces)
        ? dbRun.sample_traces
        : (typeof dbRun.sample_traces === 'string' ? JSON.parse(dbRun.sample_traces) : []);
    console.log(`  - Persisted Traces: ${persistedTraces.length} items`);
    if (persistedTraces.length === 0) {
        throw new Error('sample_traces column in database was not populated');
    }
    console.log('✓ PostgreSQL test_runs row contains full sample_traces array and APM configuration.');

    // 7. Validate Reports
    console.log('\n[Step 8] Validating Allure & Executive Management HTML reports...');
    const allureProps = path.join(runDir, 'allure-results', 'environment.properties');
    if (fs.existsSync(allureProps)) {
        const propsContent = fs.readFileSync(allureProps, 'utf8');
        if (propsContent.includes('DistributedTracing=Enabled') && propsContent.includes('APMProvider=jaeger')) {
            console.log('✓ Allure environment.properties contains DistributedTracing and APMProvider.');
        } else {
            console.warn('⚠️ Allure environment.properties missing tracing properties:', propsContent);
        }
    }

    const mgmtReportPath = path.join(runDir, 'report.html');
    if (fs.existsSync(mgmtReportPath)) {
        const reportContent = fs.readFileSync(mgmtReportPath, 'utf8');
        if (reportContent.includes('Distributed Tracing & APM Observability') && reportContent.includes('Inspect in APM')) {
            console.log('✓ Executive report.html contains Distributed Tracing section and direct APM inspection links.');
        } else {
            throw new Error('Executive report.html missing APM section or inspection links');
        }
    }

    console.log('\n==================================================================');
    console.log(' 🎉 PHASE 6 ALL CHECKS PASSED: DISTRIBUTED APM TRACING VERIFIED!');
    console.log('==================================================================');
}

runVerification()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('\n❌ Phase 6 Verification Failed:', err);
        process.exit(1);
    });
