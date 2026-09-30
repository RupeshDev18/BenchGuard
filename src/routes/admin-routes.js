const express = require('express');
const router = express.Router();
const { query, getClient } = require('../db/database');
const { hashPassword } = require('../auth/auth-utils');
const { authenticateToken, requireSuperadmin } = require('../auth/middlewares');

// All admin routes require Superadmin authentication
router.use(authenticateToken);
router.use(requireSuperadmin);

/**
 * GET /api/admin/overview
 * Global platform overview and system metrics.
 */
router.get('/overview', async (req, res) => {
    try {
        const [orgsCount, usersCount, projectsCount, runsCount] = await Promise.all([
            query('SELECT COUNT(*) as count FROM organizations'),
            query('SELECT COUNT(*) as count FROM users'),
            query('SELECT COUNT(*) as count FROM projects'),
            query('SELECT COUNT(*) as count FROM test_runs')
        ]);

        const recentRuns = await query(`
            SELECT r.id, r.run_number, r.build_label, r.started_at, r.passed, r.throughput_rps, r.p95_latency_ms,
                   o.name as org_name, p.name as project_name
            FROM test_runs r
            LEFT JOIN organizations o ON r.org_id = o.id
            LEFT JOIN projects p ON r.project_id = p.id
            ORDER BY r.created_at DESC LIMIT 5
        `);

        res.json({
            metrics: {
                totalOrganizations: parseInt(orgsCount.rows[0].count, 10),
                totalUsers: parseInt(usersCount.rows[0].count, 10),
                totalProjects: parseInt(projectsCount.rows[0].count, 10),
                totalTestRuns: parseInt(runsCount.rows[0].count, 10)
            },
            recentRuns: recentRuns.rows
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to retrieve admin overview: ' + err.message });
    }
});

/**
 * GET /api/admin/organizations
 * Lists all organizations with associated user and project counts.
 */
router.get('/organizations', async (req, res) => {
    try {
        const listQuery = `
            SELECT 
                o.*,
                (SELECT COUNT(*) FROM organization_members WHERE org_id = o.id) as member_count,
                (SELECT COUNT(*) FROM projects WHERE org_id = o.id) as project_count,
                (SELECT COUNT(*) FROM test_runs WHERE org_id = o.id) as run_count
            FROM organizations o
            ORDER BY o.created_at DESC
        `;
        const result = await query(listQuery);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to list organizations: ' + err.message });
    }
});

/**
 * POST /api/admin/organizations
 * Onboards a new Organization and provisions its Org Admin atomically.
 */
router.post('/organizations', async (req, res) => {
    const orgName = req.body.orgName || req.body.name;
    const orgSlug = req.body.orgSlug || req.body.slug;
    const planTier = req.body.planTier || req.body.plan || 'team';
    const maxVusAllowed = req.body.maxVusAllowed || 100;
    const maxProjects = req.body.maxProjects || 10;
    const adminEmail = req.body.adminEmail;
    const adminFullName = req.body.adminFullName || 'Organization Admin';
    const adminPassword = req.body.adminPassword;
    const createStarterProject = req.body.createStarterProject !== false;

    if (!orgName || !orgSlug || !adminEmail || !adminPassword) {
        return res.status(400).json({
            error: 'Missing required onboarding fields: orgName, orgSlug, adminEmail, adminPassword are required.'
        });
    }

    const cleanSlug = orgSlug.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '-');
    const client = await getClient();

    try {
        await client.query('BEGIN');

        // Check if slug or email exists
        const existingSlug = await client.query('SELECT id FROM organizations WHERE slug = $1', [cleanSlug]);
        if (existingSlug.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: `Organization slug '${cleanSlug}' is already taken.` });
        }

        // 1. Create Organization
        const orgRes = await client.query(`
            INSERT INTO organizations (name, slug, plan_tier, max_vus_allowed, max_projects)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `, [orgName.trim(), cleanSlug, planTier, Number(maxVusAllowed), Number(maxProjects)]);
        const org = orgRes.rows[0];

        // 2. Find or Create Org Admin User
        let adminUserId;
        const userCheck = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [adminEmail.trim()]);
        if (userCheck.rows.length > 0) {
            adminUserId = userCheck.rows[0].id;
        } else {
            const pwHash = await hashPassword(adminPassword);
            const newUserRes = await client.query(`
                INSERT INTO users (email, password_hash, full_name, is_superadmin)
                VALUES ($1, $2, $3, false)
                RETURNING id
            `, [adminEmail.trim().toLowerCase(), pwHash, adminFullName || adminEmail.split('@')[0]]);
            adminUserId = newUserRes.rows[0].id;
        }

        // 3. Map user as 'admin' in organization_members
        await client.query(`
            INSERT INTO organization_members (org_id, user_id, role)
            VALUES ($1, $2, 'admin')
            ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'admin'
        `, [org.id, adminUserId]);

        // 4. Optionally create initial Starter Project
        let starterProject = null;
        if (createStarterProject) {
            const projRes = await client.query(`
                INSERT INTO projects (org_id, name, slug, description, created_by)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *
            `, [org.id, 'API Services', 'api-services', 'Initial project for performance testing', adminUserId]);
            starterProject = projRes.rows[0];

            await client.query(`
                INSERT INTO project_environments (project_id, name, base_url)
                VALUES ($1, 'Staging', 'http://localhost:8080')
            `, [starterProject.id]);
        }

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            message: `Organization '${org.name}' onboarded successfully.`,
            organization: org,
            orgAdmin: {
                id: adminUserId,
                email: adminEmail,
                role: 'admin'
            },
            starterProject
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Organization onboarding transaction failed: ' + err.message });
    } finally {
        client.release();
    }
});

/**
 * PATCH /api/admin/organizations/:orgId
 * Updates organization plan tier, active status, or resource quotas.
 */
router.patch('/organizations/:orgId', async (req, res) => {
    const { orgId } = req.params;
    const { name, planTier, maxVusAllowed, maxProjects, isActive } = req.body;

    try {
        const updates = [];
        const params = [orgId];

        if (name !== undefined) {
            params.push(name.trim());
            updates.push(`name = $${params.length}`);
        }
        if (planTier !== undefined) {
            params.push(planTier);
            updates.push(`plan_tier = $${params.length}`);
        }
        if (maxVusAllowed !== undefined) {
            params.push(Number(maxVusAllowed));
            updates.push(`max_vus_allowed = $${params.length}`);
        }
        if (maxProjects !== undefined) {
            params.push(Number(maxProjects));
            updates.push(`max_projects = $${params.length}`);
        }
        if (isActive !== undefined) {
            params.push(Boolean(isActive));
            updates.push(`is_active = $${params.length}`);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No update fields provided.' });
        }

        const updateQuery = `
            UPDATE organizations 
            SET ${updates.join(', ')}
            WHERE id = $1
            RETURNING *
        `;

        const result = await query(updateQuery, params);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Organization not found.' });
        }

        res.json({ success: true, organization: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update organization: ' + err.message });
    }
});

module.exports = router;
