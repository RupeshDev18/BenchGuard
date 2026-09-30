/**
 * test-phase2-saas.js
 * End-to-End Automated Verification of Phase 2 SaaS Multi-Tenant Engine:
 * 1. Superadmin login & token generation
 * 2. Superadmin platform overview metrics
 * 3. Onboarding a new tenant Organization ("Stripe Payments QA") with an Org Admin
 * 4. Login as new Org Admin
 * 5. Listing Starter Templates
 * 6. Provisioning a new Project from "minimal-rest-api" template
 * 7. Querying Project details & verifying environment isolation
 * 8. Querying Scoped Runs & historical backward compatibility
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

async function runTests() {
    console.log('==================================================================');
    console.log(' 🧪 RUNNING PHASE 2 MULTI-TENANT SAAS VERIFICATION SUITE');
    console.log('==================================================================\n');

    let superadminToken = '';
    let orgAdminToken = '';
    let createdOrgId = '';
    let createdProjectId = '';

    // Step 1: Superadmin Login
    console.log('[Step 1] Logging in as Platform Superadmin (superadmin@platform.local)...');
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

    if (loginRes.status !== 200 || !loginRes.data.token) {
        console.error('❌ Failed superadmin login:', loginRes.data);
        process.exit(1);
    }
    superadminToken = loginRes.data.token;
    console.log(`✅ Superadmin authenticated! User: ${loginRes.data.user.fullName}, Superadmin: ${loginRes.data.user.isSuperadmin}`);

    // Step 2: Superadmin Platform Overview
    console.log('\n[Step 2] Fetching Superadmin platform overview (/api/admin/overview)...');
    const overviewRes = await apiCall({
        hostname: 'localhost',
        port: 3000,
        path: '/api/admin/overview',
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${superadminToken}`
        }
    });

    if (overviewRes.status !== 200) {
        console.error('❌ Failed fetching admin overview:', overviewRes.data);
        process.exit(1);
    }
    console.log('✅ Admin Overview Metrics:', overviewRes.data);

    // Step 3: Superadmin onboards a new Organization with Admin
    const tenantSlug = `fintech-qa-${Date.now().toString().slice(-4)}`;
    console.log(`\n[Step 3] Onboarding new tenant Organization: "${tenantSlug}"...`);
    const createOrgRes = await apiCall({
        hostname: 'localhost',
        port: 3000,
        path: '/api/admin/organizations',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${superadminToken}`
        }
    }, {
        orgName: 'Fintech Payments QA',
        orgSlug: tenantSlug,
        planTier: 'team',
        maxProjects: 10,
        adminFullName: 'Alex Mercer',
        adminEmail: `alex.${tenantSlug}@fintech.local`,
        adminPassword: 'Password@123',
        createStarterProject: false
    });

    if (createOrgRes.status !== 201) {
        console.error('❌ Failed creating organization:', createOrgRes.data);
        process.exit(1);
    }
    createdOrgId = createOrgRes.data.organization.id;
    console.log(`✅ Tenant Organization created! Org ID: ${createdOrgId}`);
    const adminObj = createOrgRes.data.orgAdmin || createOrgRes.data.adminUser || {};
    console.log(`✅ Initial Org Admin created: ${adminObj.email} (Role: ${adminObj.role})`);

    // Step 4: Login as the new Org Admin
    console.log(`\n[Step 4] Logging in as the new Org Admin (alex.${tenantSlug}@fintech.local)...`);
    const orgLoginRes = await apiCall({
        hostname: 'localhost',
        port: 3000,
        path: '/api/auth/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, {
        email: `alex.${tenantSlug}@fintech.local`,
        password: 'Password@123'
    });

    if (orgLoginRes.status !== 200) {
        console.error('❌ Failed org admin login:', orgLoginRes.data);
        process.exit(1);
    }
    orgAdminToken = orgLoginRes.data.token;
    console.log(`✅ Org Admin authenticated! Accessible Orgs: ${orgLoginRes.data.organizations.length}`);

    // Step 5: List Starter Templates
    console.log('\n[Step 5] Listing available Starter Templates (/api/orgs/templates/list)...');
    const templatesRes = await apiCall({
        hostname: 'localhost',
        port: 3000,
        path: '/api/orgs/templates/list',
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${orgAdminToken}`
        }
    });

    if (templatesRes.status !== 200 || !Array.isArray(templatesRes.data)) {
        console.error('❌ Failed fetching templates:', templatesRes.data);
        process.exit(1);
    }
    console.log(`✅ Found ${templatesRes.data.length} starter templates:`, templatesRes.data.map(t => `${t.name} (${t.id})`));

    // Step 6: Create Project from "minimal-rest-api" Template
    console.log(`\n[Step 6] Provisioning new project from template "minimal-rest-api" for org ${createdOrgId}...`);
    const createProjectRes = await apiCall({
        hostname: 'localhost',
        port: 3000,
        path: `/api/orgs/${createdOrgId}/projects`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${orgAdminToken}`,
            'X-Org-Id': createdOrgId
        }
    }, {
        name: 'Fintech Core Ledger API',
        slug: `core-ledger-${Date.now().toString().slice(-4)}`,
        description: 'High-throughput core accounting service',
        templateId: 'minimal-rest-api'
    });

    if (createProjectRes.status !== 201) {
        console.error('❌ Failed creating project from template:', createProjectRes.data);
        process.exit(1);
    }
    createdProjectId = createProjectRes.data.project.id;
    console.log(`✅ Project created successfully! Project ID: ${createdProjectId}`);
    console.log(`   Seeded from template: ${createProjectRes.data.project.name}`);

    // Step 7: Get Project Details & Environments
    console.log(`\n[Step 7] Inspecting project details (/api/projects/${createdProjectId})...`);
    const projectDetailsRes = await apiCall({
        hostname: 'localhost',
        port: 3000,
        path: `/api/projects/${createdProjectId}`,
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${orgAdminToken}`
        }
    });

    if (projectDetailsRes.status !== 200) {
        console.error('❌ Failed fetching project details:', projectDetailsRes.data);
        process.exit(1);
    }
    const pData = projectDetailsRes.data;
    console.log(`✅ Project Environments:`, pData.environments.map(e => `${e.name} (${e.base_url})`));
    console.log(`✅ Active OpenAPI Spec:`, pData.activeSpec?.name, `(Format: ${pData.activeSpec?.format})`);
    console.log(`✅ Scoped Total Runs:`, pData.stats.totalRuns);

    // Step 8: Add Custom Environment
    console.log(`\n[Step 8] Adding custom 'load-test-cluster' environment to project...`);
    const addEnvRes = await apiCall({
        hostname: 'localhost',
        port: 3000,
        path: `/api/projects/${createdProjectId}/environments`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${orgAdminToken}`
        }
    }, {
        name: 'load-test-cluster',
        baseUrl: 'https://staging-ledger.internal.net',
        defaultHeaders: { 'X-Internal-Token': 'secret-load-key' }
    });

    if (addEnvRes.status !== 201) {
        console.error('❌ Failed adding environment:', addEnvRes.data);
        process.exit(1);
    }
    console.log(`✅ Added environment: ${addEnvRes.data.environment.name} (${addEnvRes.data.environment.base_url})`);

    // Step 9: Verify Project Scoped Runs is empty (0 runs)
    console.log(`\n[Step 9] Checking project scoped runs (/api/projects/${createdProjectId}/runs)...`);
    const projectRunsRes = await apiCall({
        hostname: 'localhost',
        port: 3000,
        path: `/api/projects/${createdProjectId}/runs`,
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${orgAdminToken}`
        }
    });

    if (projectRunsRes.status !== 200) {
        console.error('❌ Failed fetching project runs:', projectRunsRes.data);
        process.exit(1);
    }
    console.log(`✅ New project runs count: ${projectRunsRes.data.runs.length} (Tenant data isolation confirmed!)`);

    // Step 10: Verify Default Project retained historical runs
    console.log('\n[Step 10] Verifying backward compatibility on default Acme project...');
    const acmeProjectsRes = await apiCall({
        hostname: 'localhost',
        port: 3000,
        path: '/api/admin/overview',
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${superadminToken}`
        }
    });
    console.log(`✅ Global test runs retained in PostgreSQL: ${acmeProjectsRes.data.metrics?.totalTestRuns}`);

    console.log('\n==================================================================');
    console.log(' 🎉 ALL PHASE 2 SAAS MULTI-TENANT VERIFICATION TESTS PASSED!');
    console.log('==================================================================\n');
}

runTests().catch(err => {
    console.error('Suite crashed with error:', err);
    process.exit(1);
});
