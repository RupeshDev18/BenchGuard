/**
 * verify-phase5-scheduler.js
 * End-to-End Automated Verification of Phase 5 Scheduled Benchmarks & Webhook Alerting:
 * 1. Authenticate as Superadmin
 * 2. Start a mock Webhook receiver HTTP server (localhost:9999)
 * 3. Register a Webhook for the project
 * 4. Verify test webhook ping
 * 5. Create a new automated benchmark schedule
 * 6. Trigger schedule execution manually
 * 7. Poll execution until completion
 * 8. Verify schedule status in PostgreSQL (last_run_status, last_run_at, last_run_id)
 * 9. Verify mock webhook server received the 'run.completed' notification payload
 * 10. Clean up and report results
 */

const http = require('http');

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

async function runVerification() {
    console.log('==================================================================');
    console.log(' 🚀 RUNNING PHASE 5 AUTOMATED SCHEDULES & ALERTS VERIFICATION');
    console.log('==================================================================\n');

    // Step 0: Start local mock webhook server
    const receivedWebhookPayloads = [];
    const mockWebhookPort = 9999;
    const mockServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            let parsed = null;
            try { parsed = JSON.parse(body); } catch (_) { parsed = body; }
            receivedWebhookPayloads.push({
                url: req.url,
                method: req.method,
                headers: req.headers,
                body: parsed
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, received: true }));
        });
    });

    await new Promise(resolve => mockServer.listen(mockWebhookPort, resolve));
    console.log(`[Step 0] Mock Webhook Receiver listening on http://localhost:${mockWebhookPort}/webhook`);

    try {
        // Step 1: Login
        console.log('\n[Step 1] Authenticating as Platform Superadmin...');
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
            throw new Error(`Login failed: ${JSON.stringify(loginRes.data)}`);
        }
        const token = loginRes.data.token;
        const activeOrg = loginRes.data.organizations[0];
        console.log(`✅ Authenticated! Org: ${activeOrg.name} (${activeOrg.id})`);

        // Step 2: Fetch Projects
        console.log(`\n[Step 2] Fetching projects for organization ${activeOrg.id}...`);
        const projRes = await apiCall({
            hostname: 'localhost',
            port: 3000,
            path: `/api/orgs/${activeOrg.id}/projects`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const project = projRes.data[0];
        console.log(`✅ Selected Project: ${project.name} (${project.id})`);

        // Step 3: Register Webhook
        console.log('\n[Step 3] Registering Notification Webhook...');
        const webhookUrl = `http://localhost:${mockWebhookPort}/webhook`;
        const addWhRes = await apiCall({
            hostname: 'localhost',
            port: 3000,
            path: `/api/projects/${project.id}/webhooks`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        }, {
            name: 'Local Test Alert Channel',
            url: webhookUrl,
            events: ['run.completed', 'sla.failed'],
            secret: 'secret-test-token-123'
        });

        if (addWhRes.status !== 201) {
            throw new Error(`Failed adding webhook: ${JSON.stringify(addWhRes.data)}`);
        }
        const webhookId = addWhRes.data.webhook.id;
        console.log(`✅ Webhook registered! ID: ${webhookId}`);

        // Step 4: Test Webhook Ping
        console.log('\n[Step 4] Testing Webhook Ping...');
        const pingRes = await apiCall({
            hostname: 'localhost',
            port: 3000,
            path: `/api/projects/${project.id}/webhooks/test`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        }, {
            url: webhookUrl,
            secret: 'secret-test-token-123'
        });

        if (!pingRes.data.success) {
            throw new Error(`Webhook ping failed: ${JSON.stringify(pingRes.data)}`);
        }
        console.log(`✅ Webhook ping delivered successfully! Status: ${pingRes.data.statusCode}`);

        // Step 5: Create Automated Schedule
        console.log('\n[Step 5] Creating Automated Benchmark Schedule...');
        const createSchRes = await apiCall({
            hostname: 'localhost',
            port: 3000,
            path: `/api/projects/${project.id}/schedules`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        }, {
            name: 'Nightly Verification Benchmark',
            cronExpression: '0 2 * * *',
            peakVus: 8,
            durationSec: 5,
            p95ThresholdMs: 500,
            maxErrorRatePct: 1.0
        });

        if (createSchRes.status !== 201) {
            throw new Error(`Failed creating schedule: ${JSON.stringify(createSchRes.data)}`);
        }
        const schedule = createSchRes.data.schedule;
        console.log(`✅ Schedule created! ID: ${schedule.id} | Cron: ${schedule.cron_expression}`);

        // Step 6: Trigger Schedule Now
        console.log('\n[Step 6] Triggering schedule manually (POST /trigger)...');
        const triggerRes = await apiCall({
            hostname: 'localhost',
            port: 3000,
            path: `/api/projects/${project.id}/schedules/${schedule.id}/trigger`,
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (triggerRes.status !== 200) {
            throw new Error(`Failed triggering schedule: ${JSON.stringify(triggerRes.data)}`);
        }
        console.log(`✅ Schedule triggered: ${triggerRes.data.message}`);

        // Step 7: Poll execution until completion
        console.log('\n[Step 7] Polling pipeline status until completion...');
        let isRunning = true;
        let attempts = 0;
        while (isRunning && attempts < 25) {
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
        console.log('\n✅ Scheduled pipeline execution completed!');

        // Step 8: Check Schedule Status in Database
        console.log('\n[Step 8] Verifying schedule updated in database...');
        const listSchRes = await apiCall({
            hostname: 'localhost',
            port: 3000,
            path: `/api/projects/${project.id}/schedules`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const updatedSch = listSchRes.data.find(s => s.id === schedule.id);
        console.log(`   Schedule Name   : ${updatedSch.name}`);
        console.log(`   Last Run Status : ${updatedSch.last_run_status}`);
        console.log(`   Last Run ID     : ${updatedSch.last_run_id}`);
        console.log(`   Last Run At     : ${updatedSch.last_run_at}`);

        if (!updatedSch.last_run_at || (updatedSch.last_run_status !== 'passed' && updatedSch.last_run_status !== 'failed')) {
            throw new Error(`Schedule was not updated properly: ${JSON.stringify(updatedSch)}`);
        }
        console.log(`✅ Schedule database status verified!`);

        // Step 9: Verify Mock Webhook Receiver got payload
        console.log('\n[Step 9] Checking webhook delivery on mock receiver...');
        console.log(`   Total payloads received: ${receivedWebhookPayloads.length}`);
        const runCompletedPayload = receivedWebhookPayloads.find(p => p.body && (p.body.event === 'run.completed' || p.body.data?.verdict));
        
        if (!runCompletedPayload) {
            throw new Error(`Mock receiver did not receive 'run.completed' webhook event!`);
        }

        console.log(`✅ Webhook Payload Received:`);
        console.log(`   Event       : ${runCompletedPayload.body.event}`);
        console.log(`   Project     : ${runCompletedPayload.body.data.projectName}`);
        console.log(`   Verdict     : ${runCompletedPayload.body.data.verdict}`);
        console.log(`   Throughput  : ${runCompletedPayload.body.data.throughputRps} req/s`);
        console.log(`   p95 Latency : ${runCompletedPayload.body.data.p95LatencyMs} ms`);
        console.log(`   HMAC Header : ${runCompletedPayload.headers['x-signature-sha256'] ? '✅ Present' : 'None'}`);

        // Step 10: Clean up
        console.log('\n[Step 10] Cleaning up test schedule and webhook...');
        await apiCall({
            hostname: 'localhost',
            port: 3000,
            path: `/api/projects/${project.id}/schedules/${schedule.id}`,
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        await apiCall({
            hostname: 'localhost',
            port: 3000,
            path: `/api/projects/${project.id}/webhooks/${webhookId}`,
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log('✅ Cleaned up temporary test schedule & webhook.');

        console.log('\n==================================================================');
        console.log(' 🎉 ALL PHASE 5 AUTOMATED SCHEDULE & ALERT TESTS PASSED!');
        console.log('==================================================================\n');

    } finally {
        mockServer.close();
    }
}

runVerification().catch(err => {
    console.error('\n❌ Verification Failed:', err.message);
    process.exit(1);
});
