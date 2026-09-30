const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { query, getClient } = require('../db/database');
const { hashPassword } = require('../auth/auth-utils');
const { authenticateToken, requireOrgRole } = require('../auth/middlewares');

// Base authentication for all org routes
router.use(authenticateToken);

/**
 * GET /api/orgs/templates/list
 * Returns all available starter templates for project creation.
 */
router.get('/templates/list', (req, res) => {
    const templatesDir = path.resolve(__dirname, '../../templates/starter-kit');
    const templates = [];

    if (fs.existsSync(templatesDir)) {
        const dirs = fs.readdirSync(templatesDir);
        for (const dir of dirs) {
            const manifestPath = path.join(templatesDir, dir, 'template.json');
            if (fs.existsSync(manifestPath)) {
                try {
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                    templates.push(manifest);
                } catch (e) {
                    console.warn(`[templates] Error reading ${manifestPath}: ${e.message}`);
                }
            }
        }
    }

    res.json(templates);
});

/**
 * GET /api/orgs/:orgId
 * Returns organization details, quota limits, and member count.
 */
router.get('/:orgId', requireOrgRole(['admin', 'developer', 'viewer']), async (req, res) => {
    try {
        const orgRes = await query(`
            SELECT o.*, 
                   (SELECT COUNT(*) FROM organization_members WHERE org_id = o.id) as member_count,
                   (SELECT COUNT(*) FROM projects WHERE org_id = o.id) as project_count
            FROM organizations o
            WHERE o.id = $1
        `, [req.orgId]);

        if (orgRes.rows.length === 0) {
            return res.status(404).json({ error: 'Organization not found.' });
        }

        res.json({
            ...orgRes.rows[0],
            currentUserRole: req.orgRole
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch organization: ' + err.message });
    }
});

/**
 * GET /api/orgs/:orgId/members
 * Lists team members, emails, roles, and join dates.
 */
router.get('/:orgId/members', requireOrgRole(['admin', 'developer', 'viewer']), async (req, res) => {
    try {
        const membersRes = await query(`
            SELECT u.id, u.email, u.full_name, m.role, m.joined_at
            FROM organization_members m
            JOIN users u ON m.user_id = u.id
            WHERE m.org_id = $1
            ORDER BY m.joined_at ASC
        `, [req.orgId]);

        res.json(membersRes.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch team members: ' + err.message });
    }
});

/**
 * POST /api/orgs/:orgId/members
 * Adds or invites a user to the organization. Requires 'admin' role.
 */
router.post('/:orgId/members', requireOrgRole(['admin']), async (req, res) => {
    const { email, fullName, role = 'developer', temporaryPassword = 'User@12345' } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'User email is required.' });
    }

    if (!['admin', 'developer', 'viewer'].includes(role)) {
        return res.status(400).json({ error: "Role must be one of: 'admin', 'developer', 'viewer'." });
    }

    const client = await getClient();
    try {
        await client.query('BEGIN');

        // Check if user exists
        let userId;
        const userCheck = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email.trim()]);
        if (userCheck.rows.length > 0) {
            userId = userCheck.rows[0].id;
        } else {
            const pwHash = await hashPassword(temporaryPassword);
            const newUserRes = await client.query(`
                INSERT INTO users (email, password_hash, full_name, is_superadmin)
                VALUES ($1, $2, $3, false)
                RETURNING id
            `, [email.trim().toLowerCase(), pwHash, fullName || email.split('@')[0]]);
            userId = newUserRes.rows[0].id;
        }

        // Add to organization_members
        const memberRes = await client.query(`
            INSERT INTO organization_members (org_id, user_id, role)
            VALUES ($1, $2, $3)
            ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role
            RETURNING *
        `, [req.orgId, userId, role]);

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            message: `User ${email} added as ${role}.`,
            member: memberRes.rows[0]
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Failed to add team member: ' + err.message });
    } finally {
        client.release();
    }
});

/**
 * PATCH /api/orgs/:orgId/members/:userId
 * Updates a member's role. Requires 'admin' role.
 */
router.patch('/:orgId/members/:userId', requireOrgRole(['admin']), async (req, res) => {
    const { userId } = req.params;
    const { role } = req.body;

    if (!['admin', 'developer', 'viewer'].includes(role)) {
        return res.status(400).json({ error: "Role must be one of: 'admin', 'developer', 'viewer'." });
    }

    try {
        const updateRes = await query(`
            UPDATE organization_members
            SET role = $1
            WHERE org_id = $2 AND user_id = $3
            RETURNING *
        `, [role, req.orgId, userId]);

        if (updateRes.rows.length === 0) {
            return res.status(404).json({ error: 'Member not found in this organization.' });
        }

        res.json({ success: true, member: updateRes.rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update member role: ' + err.message });
    }
});

/**
 * DELETE /api/orgs/:orgId/members/:userId
 * Removes a member from the organization. Requires 'admin' role.
 */
router.delete('/:orgId/members/:userId', requireOrgRole(['admin']), async (req, res) => {
    const { userId } = req.params;

    // Prevent removing oneself if they are the only admin
    if (userId === req.user.id) {
        const adminCount = await query(
            "SELECT COUNT(*) FROM organization_members WHERE org_id = $1 AND role = 'admin'",
            [req.orgId]
        );
        if (parseInt(adminCount.rows[0].count, 10) <= 1) {
            return res.status(400).json({ error: 'Cannot remove yourself: You are the sole administrator of this organization.' });
        }
    }

    try {
        const delRes = await query(
            'DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2 RETURNING *',
            [req.orgId, userId]
        );

        if (delRes.rows.length === 0) {
            return res.status(404).json({ error: 'Member not found in this organization.' });
        }

        res.json({ success: true, message: 'Member removed from organization.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove member: ' + err.message });
    }
});

/**
 * GET /api/orgs/:orgId/projects
 * Lists all projects in the organization.
 */
router.get('/:orgId/projects', requireOrgRole(['admin', 'developer', 'viewer']), async (req, res) => {
    try {
        const projectsRes = await query(`
            SELECT p.*,
                   (SELECT COUNT(*) FROM test_runs WHERE project_id = p.id) as run_count,
                   (SELECT COUNT(*) FROM project_environments WHERE project_id = p.id) as environment_count,
                   (SELECT COUNT(*) FROM project_specs WHERE project_id = p.id) as spec_count
            FROM projects p
            WHERE p.org_id = $1
            ORDER BY p.created_at DESC
        `, [req.orgId]);

        res.json(projectsRes.rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to list projects: ' + err.message });
    }
});

/**
 * POST /api/orgs/:orgId/projects
 * Creates a project (Blank or populated from a starter template).
 */
router.post('/:orgId/projects', requireOrgRole(['admin', 'developer']), async (req, res) => {
    const { name, slug, description, templateId, baseUrl = 'http://localhost:8080' } = req.body;

    if (!name || !slug) {
        return res.status(400).json({ error: 'Project name and slug are required.' });
    }

    const cleanSlug = slug.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '-');
    const client = await getClient();

    try {
        await client.query('BEGIN');

        // Check if slug exists in org
        const existing = await client.query(
            'SELECT id FROM projects WHERE org_id = $1 AND slug = $2',
            [req.orgId, cleanSlug]
        );
        if (existing.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: `Project slug '${cleanSlug}' already exists in this organization.` });
        }

        // 1. Create Project
        const projRes = await client.query(`
            INSERT INTO projects (org_id, name, slug, description, created_by)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `, [req.orgId, name.trim(), cleanSlug, description || '', req.user.id]);
        const project = projRes.rows[0];

        // 2. Create Default Environments
        await client.query(`
            INSERT INTO project_environments (project_id, name, base_url)
            VALUES ($1, 'Staging', $2), ($1, 'Production', $2)
        `, [project.id, baseUrl]);

        // 3. If template selected, import specification
        if (templateId) {
            const templatePath = path.resolve(__dirname, `../../templates/starter-kit/${templateId}`);
            const manifestPath = path.join(templatePath, 'template.json');

            if (fs.existsSync(manifestPath)) {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                const specFilePath = path.join(templatePath, manifest.specFile);

                if (fs.existsSync(specFilePath)) {
                    const rawSpec = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
                    await client.query(`
                        INSERT INTO project_specs (project_id, name, version, format, raw_content)
                        VALUES ($1, $2, $3, $4, $5)
                    `, [
                        project.id,
                        manifest.name,
                        rawSpec.info?.version || '1.0.0',
                        rawSpec.openapi ? `OpenAPI ${rawSpec.openapi}` : 'Swagger 2.0',
                        JSON.stringify(rawSpec)
                    ]);
                }
            }
        }

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            message: `Project '${project.name}' created successfully.`,
            project
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Failed to create project: ' + err.message });
    } finally {
        client.release();
    }
});

module.exports = router;
