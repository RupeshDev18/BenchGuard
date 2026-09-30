const { verifyToken } = require('./auth-utils');
const { query } = require('../db/database');

/**
 * Validates JWT Bearer token and attaches req.user.
 */
async function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : req.query.token;

    if (!token) {
        return res.status(401).json({ error: 'Authentication required. Missing Bearer token.' });
    }

    const decoded = verifyToken(token);
    if (!decoded || !decoded.userId) {
        return res.status(403).json({ error: 'Invalid or expired authentication token.' });
    }

    try {
        const userRes = await query('SELECT id, email, full_name, is_superadmin FROM users WHERE id = $1', [decoded.userId]);
        if (userRes.rows.length === 0) {
            return res.status(403).json({ error: 'User account no longer exists.' });
        }
        req.user = userRes.rows[0];
        next();
    } catch (err) {
        return res.status(500).json({ error: 'Authentication verification failure: ' + err.message });
    }
}

/**
 * Requires the authenticated caller to be a Platform Superadmin.
 */
function requireSuperadmin(req, res, next) {
    if (!req.user || !req.user.is_superadmin) {
        return res.status(403).json({ error: 'Access denied. Superadmin privileges required.' });
    }
    next();
}

/**
 * Resolves active organization and validates user membership and required roles.
 * @param {Array<string>} allowedRoles - Optional list of allowed roles (e.g. ['admin'], ['admin', 'developer'])
 */
function requireOrgRole(allowedRoles = ['admin', 'developer', 'viewer']) {
    return async (req, res, next) => {
        const orgId = req.params.orgId || req.headers['x-org-id'] || req.query.orgId;
        if (!orgId) {
            return res.status(400).json({ error: 'Missing organization identifier (X-Org-Id header or orgId parameter).' });
        }

        // Superadmin bypasses org membership checks
        if (req.user && req.user.is_superadmin) {
            req.orgId = orgId;
            req.orgRole = 'superadmin';
            return next();
        }

        try {
            const memberRes = await query(
                'SELECT role FROM organization_members WHERE org_id = $1 AND user_id = $2',
                [orgId, req.user.id]
            );

            if (memberRes.rows.length === 0) {
                return res.status(403).json({ error: 'You are not a member of this organization.' });
            }

            const userRole = memberRes.rows[0].role;
            if (!allowedRoles.includes(userRole)) {
                return res.status(403).json({
                    error: `Insufficient permissions. Requires one of: [${allowedRoles.join(', ')}], but your role is '${userRole}'.`
                });
            }

            req.orgId = orgId;
            req.orgRole = userRole;
            next();
        } catch (err) {
            return res.status(500).json({ error: 'Authorization verification failure: ' + err.message });
        }
    };
}

/**
 * Resolves project and checks user's organization membership and role.
 * @param {Array<string>} allowedRoles
 */
function requireProjectRole(allowedRoles = ['admin', 'developer', 'viewer']) {
    return async (req, res, next) => {
        const projectId = req.params.projectId;
        if (!projectId) {
            return res.status(400).json({ error: 'Missing projectId parameter.' });
        }

        try {
            const projRes = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
            if (projRes.rows.length === 0) {
                return res.status(404).json({ error: 'Project not found.' });
            }

            const project = projRes.rows[0];
            req.project = project;
            req.orgId = project.org_id;

            // Superadmin bypasses checks
            if (req.user && req.user.is_superadmin) {
                req.orgRole = 'superadmin';
                return next();
            }

            const memberRes = await query(
                'SELECT role FROM organization_members WHERE org_id = $1 AND user_id = $2',
                [project.org_id, req.user.id]
            );

            if (memberRes.rows.length === 0) {
                return res.status(403).json({ error: 'You do not have access to this project.' });
            }

            const userRole = memberRes.rows[0].role;
            if (!allowedRoles.includes(userRole)) {
                return res.status(403).json({
                    error: `Insufficient permissions. Requires one of: [${allowedRoles.join(', ')}], but your role is '${userRole}'.`
                });
            }

            req.orgRole = userRole;
            next();
        } catch (err) {
            return res.status(500).json({ error: 'Project authorization failure: ' + err.message });
        }
    };
}

module.exports = {
    authenticateToken,
    requireSuperadmin,
    requireOrgRole,
    requireProjectRole
};

