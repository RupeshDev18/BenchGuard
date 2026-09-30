/**
 * test-phase4-execution.js
 * End-to-End Automated Verification of Phase 4 Tenant-Isolated Execution Engine:
 * 1. Authenticate as Superadmin
 * 2. Retrieve default Project ("E-Commerce Storefront")
 * 3. Trigger project-scoped pipeline run (POST /api/projects/:projectId/pipeline/start)
 * 4. Poll status until run completes
 * 5. Verify isolated directory structure in report-output/tenants/<orgId>/<projectId>/
 * 6. Verify run record in PostgreSQL contains correct org_id and project_id
 * 7. Verify reports status endpoint returns isProjectScoped: true
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

function apiCall(options, data = null) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = JSON.parse(body);
                } catch (e) {
                    parsed = body;
                }
                resolve({ status: res.statusCode, data: parsed, headers: res.headers });
            });
        });

        req.on('error', reject);
        if (data) {
            req.write(JSON.stringify(data));
        }
        req.end();
    });
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function runTests() {
    console.log('==================================================================');
    console.log(' 🚀 RUNNING PHASE 4 TENANT-ISOLATED EXECUTION VERIFICATION');
    console.log('==================================================================\n');

    // Step 1: Login as Superadmin
    console.log('[Step 1] Authenticating as Platform Superadmin...');
    const loginRes = await apiCall({
        hostname: 'localhost',
        port: 3000,
        path: '/api/auth/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, {
        email: 'superadmin@platform.local',
        password: 'Admin@12345'
    });

    if (loginRes.status !== 200) {
        console.error('❌ Login failed:', loginRes.data);
        process.exit(1);
    }
    const token = loginRes.data.token;
    const orgs = loginRes.data.organizations;
    const activeOrg = orgs[0];
    console.log(`✅ Authenticated! Org: ${activeOrg.name} (${activeOrg.id})`);

    // Step 2: Fetch Projects for Org
    console.log(`\n[Step 2] Fetching projects for organization ${activeOrg.id}...`);
    const projRes = await apiCall({
        hostname: 'localhost',
        port: 3000,
        path: `/api/orgs/${activeOrg.id}/projects`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (projRes.status !== 200 || projRes.data.length === 0) {
        console.error('❌ Failed fetching projects:', projRes.data);
        process.exit(1);
    }
    const project = projRes.data[0];
    console.log(`✅ Selected Project: ${project.name} (ID: ${project.id})`);

    // Step 3: Trigger Scoped Pipeline Run
    console.log(`\n[Step 3] Launching isolated pipeline execution for project '${project.name}'...`);
    const startRes = await apiCall({
        hostname: 'localhost',
        port: 3000,
        path: `/api/projects/${project.id}/pipeline/start`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    }, {
        buildLabel: 'saas-scoped-v1',
        environment: 'staging',
        stages: [
            { duration: '3s', target: 5 },
            { duration: '2s', target: 0 }
        ]
    });

    if (startRes.status !== 202) {
        console.error('❌ Failed to start pipeline:', startRes.data);
        process.exit(1);
    }
    const runId = startRes.data.runId;
    console.log(`✅ Pipeline started! Run ID: ${runId}`);
    console.log(`   Output Directory: ${startRes.data.outputDirectory}`);

    // Step 4: Poll status until execution completes
    console.log('\n[Step 4] Polling pipeline status until completion...');
    let isRunning = true;
    let attempts = 0;
    while (isRunning && attempts < 30) {
        await sleep(2000);
        attempts++;
        const statusRes = await apiCall({
            hostname: 'localhost',
            port: 3000,
            path: `/api/projects/${project.id}/pipeline/status`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        isRunning = statusRes.data.running;
        process.stdout.write(`   [Polling ${attempts}] Status: ${isRunning ? 'RUNNING' : 'FINISHED'}\r`);
    }
    console.log('\n✅ Scoped pipeline execution completed!');

    // Step 5: Verify Filesystem Isolation
    console.log('\n[Step 5] Checking tenant-isolated filesystem artifacts...');
    const tenantDir = path.resolve(__dirname, `../report-output/tenants/${activeOrg.id}/${project.id}`);
    const runDir = path.join(tenantDir, 'runs', runId);
    const latestDir = path.join(tenantDir, 'latest');

    const hasRunDir = fs.existsSync(runDir);
    const hasRunSummary = fs.existsSync(path.join(runDir, 'k6-summary.json'));
    const hasRunReport = fs.existsSync(path.join(runDir, 'report.html'));
    const hasLatestReport = fs.existsSync(path.join(latestDir, 'report.html'));
    const hasLatestAllure = fs.existsSync(path.join(latestDir, 'allure-report/index.html'));

    console.log(`   Run Directory Exists: ${hasRunDir ? '✅' : '❌'} (${runDir})`);
    console.log(`   k6 Summary JSON: ${hasRunSummary ? '✅' : '❌'}`);
    console.log(`   Executive HTML Report: ${hasRunReport ? '✅' : '❌'}`);
    console.log(`   Latest Directory Report: ${hasLatestReport ? '✅' : '❌'}`);
    console.log(`   Latest Allure Report: ${hasLatestAllure ? '✅' : '❌'}`);

    if (!hasRunSummary || !hasLatestReport) {
        console.error('❌ Missing expected tenant report artifacts.');
        process.exit(1);
    }

    // Step 6: Verify PostgreSQL Multi-Tenant Association
    console.log('\n[Step 6] Verifying test run in PostgreSQL...');
    const runDetailsRes = await apiCall({
        hostname: 'localhost',
        port: 3000,
        path: `/api/projects/${project.id}/runs/${runId}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (runDetailsRes.status !== 200 || !runDetailsRes.data.run) {
        console.error('❌ Failed fetching run details from PostgreSQL:', runDetailsRes.data);
        process.exit(1);
    }
    const savedRun = runDetailsRes.data.run;
    console.log(`✅ PostgreSQL Run Record Found:`);
    console.log(`   Run Number : #${savedRun.run_number}`);
    console.log(`   Org ID     : ${savedRun.org_id} (Expected: ${activeOrg.id})`);
    console.log(`   Project ID : ${savedRun.project_id} (Expected: ${project.id})`);
    console.log(`   Throughput : ${savedRun.throughput_rps} req/s`);
    console.log(`   p95 Latency: ${savedRun.p95_latency_ms} ms`);
    console.log(`   SLA Verdict: ${savedRun.sla_verdict}`);

    if (savedRun.project_id !== project.id || savedRun.org_id !== activeOrg.id) {
        console.error('❌ Tenant isolation verification failed: foreign keys do not match!');
        process.exit(1);
    }

    // Step 7: Verify Reports Status API
    console.log('\n[Step 7] Checking project reports status API...');
    const reportsStatusRes = await apiCall({
        hostname: 'localhost',
        port: 3000,
        path: `/api/projects/${project.id}/reports/status`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
    });

    console.log(`✅ Reports Status:`, reportsStatusRes.data);
    if (!reportsStatusRes.data.isProjectScoped || !reportsStatusRes.data.hasManagementReport) {
        console.error('❌ Reports status is not project-scoped!');
        process.exit(1);
    }

    console.log('\n==================================================================');
    console.log(' 🎉 ALL PHASE 4 TENANT-ISOLATED EXECUTION TESTS PASSED!');
    console.log('==================================================================\n');
}

runTests().catch(err => {
    console.error('Suite crashed with error:', err);
    process.exit(1);
});
