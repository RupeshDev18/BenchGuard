const express = require('express');
const router = express.Router();
const { query } = require('../db/database');
const { comparePassword, generateToken } = require('../auth/auth-utils');
const { authenticateToken } = require('../auth/middlewares');

/**
 * POST /api/auth/login
 * Authenticates user credentials and returns JWT token + organization list.
 */
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }

    try {
        const userRes = await query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email.trim()]);
        if (userRes.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const user = userRes.rows[0];
        const match = await comparePassword(password, user.password_hash);
        if (!match) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        // Fetch accessible organizations
        let orgs = [];
        if (user.is_superadmin) {
            const allOrgs = await query('SELECT id, name, slug, plan_tier, is_active FROM organizations ORDER BY name ASC');
            orgs = allOrgs.rows.map(o => ({ ...o, role: 'superadmin' }));
        } else {
            const memberOrgs = await query(`
                SELECT o.id, o.name, o.slug, o.plan_tier, o.is_active, m.role
                FROM organizations o
                JOIN organization_members m ON o.id = m.org_id
                WHERE m.user_id = $1 AND o.is_active = true
                ORDER BY o.name ASC
            `, [user.id]);
            orgs = memberOrgs.rows;
        }

        const token = generateToken({
            userId: user.id,
            email: user.email,
            isSuperadmin: user.is_superadmin
        });

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                fullName: user.full_name,
                isSuperadmin: user.is_superadmin
            },
            organizations: orgs
        });
    } catch (err) {
        res.status(500).json({ error: 'Login error: ' + err.message });
    }
});

/**
 * GET /api/auth/me
 * Returns current authenticated user and organizations.
 */
router.get('/me', authenticateToken, async (req, res) => {
    try {
        let orgs = [];
        if (req.user.is_superadmin) {
            const allOrgs = await query('SELECT id, name, slug, plan_tier, is_active FROM organizations ORDER BY name ASC');
            orgs = allOrgs.rows.map(o => ({ ...o, role: 'superadmin' }));
        } else {
            const memberOrgs = await query(`
                SELECT o.id, o.name, o.slug, o.plan_tier, o.is_active, m.role
                FROM organizations o
                JOIN organization_members m ON o.id = m.org_id
                WHERE m.user_id = $1 AND o.is_active = true
                ORDER BY o.name ASC
            `, [req.user.id]);
            orgs = memberOrgs.rows;
        }

        res.json({
            user: {
                id: req.user.id,
                email: req.user.email,
                fullName: req.user.full_name,
                isSuperadmin: req.user.is_superadmin
            },
            organizations: orgs
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
