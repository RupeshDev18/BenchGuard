const { Pool, Client } = require('pg');
const fs = require('fs');
const path = require('path');
const { hashPassword } = require('../auth/auth-utils');

const DB_CONFIG = {
    user: process.env.PGUSER || 'postgres',
    host: process.env.PGHOST || 'localhost',
    database: process.env.PGDATABASE || 'k6_performance_db',
    password: process.env.PGPASSWORD || 'sa',
    port: parseInt(process.env.PGPORT || '5432', 10),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 4000
};

let pool = null;
let dbStatus = {
    connected: false,
    database: DB_CONFIG.database,
    host: DB_CONFIG.host,
    port: DB_CONFIG.port,
    user: DB_CONFIG.user,
    lastChecked: null,
    error: null,
    version: null
};

/**
 * Seeds default Superadmin, Organization, Project, and Environment if not already present.
 */
async function seedMultiTenantDefaults() {
    try {
        const superCheck = await pool.query("SELECT id FROM users WHERE is_superadmin = true LIMIT 1");
        let superId = superCheck.rows[0]?.id;

        if (!superId) {
            console.log('[Database] Seeding default Platform Superadmin...');
            const pwHash = await hashPassword('Admin@12345');
            const userRes = await pool.query(
                `INSERT INTO users (email, password_hash, full_name, is_superadmin)
                 VALUES ($1, $2, $3, true)
                 RETURNING id`,
                ['superadmin@platform.local', pwHash, 'Platform Superadmin']
            );
            superId = userRes.rows[0].id;
        }

        // Ensure default organization exists
        const orgRes = await pool.query(
            `INSERT INTO organizations (name, slug, plan_tier, max_vus_allowed, max_projects)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
             RETURNING id`,
            ['Acme Corporation', 'acme-corp', 'enterprise', 500, 20]
        );
        const orgId = orgRes.rows[0].id;

        // Ensure superadmin is member/admin of default org
        await pool.query(
            `INSERT INTO organization_members (org_id, user_id, role)
             VALUES ($1, $2, 'admin')
             ON CONFLICT (org_id, user_id) DO NOTHING`,
            [orgId, superId]
        );

        // Ensure default project exists
        const projRes = await pool.query(
            `INSERT INTO projects (org_id, name, slug, description, created_by)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
             RETURNING id`,
            [orgId, 'E-Commerce Storefront', 'ecommerce-storefront', 'Primary E-Commerce REST service with JWT and catalog', superId]
        );
        const projId = projRes.rows[0].id;

        // Ensure default environment exists
        const envCheck = await pool.query("SELECT id FROM project_environments WHERE project_id = $1 LIMIT 1", [projId]);
        let envId = envCheck.rows[0]?.id;
        if (!envId) {
            const envRes = await pool.query(
                `INSERT INTO project_environments (project_id, name, base_url)
                 VALUES ($1, $2, $3)
                 RETURNING id`,
                [projId, 'Staging (Local)', 'http://localhost:8080']
            );
            envId = envRes.rows[0].id;
        }

        // Backfill existing test_runs with default org and project
        await pool.query(
            `UPDATE test_runs SET org_id = $1, project_id = $2, environment_id = $3 WHERE project_id IS NULL`,
            [orgId, projId, envId]
        );

        console.log(`[Database] Multi-tenant seed ready: Superadmin (superadmin@platform.local), Org (acme-corp), Project (ecommerce-storefront).`);
    } catch (err) {
        console.warn(`[Database] Error during multi-tenant seeding: ${err.message}`);
    }
}

/**
 * Ensures the target database exists and applies the schema.
 */
async function initDatabase() {
    dbStatus.lastChecked = new Date().toISOString();

    // 1. Connect to root 'postgres' db to check/create target database
    const adminClient = new Client({
        user: DB_CONFIG.user,
        host: DB_CONFIG.host,
        database: 'postgres',
        password: DB_CONFIG.password,
        port: DB_CONFIG.port,
        connectionTimeoutMillis: 3000
    });

    try {
        await adminClient.connect();
        const checkDb = await adminClient.query(
            "SELECT 1 FROM pg_database WHERE datname = $1",
            [DB_CONFIG.database]
        );

        if (checkDb.rowCount === 0) {
            console.log(`[Database] Database '${DB_CONFIG.database}' not found. Creating it now...`);
            const safeDbName = DB_CONFIG.database.replace(/[^a-zA-Z0-9_]/g, '');
            await adminClient.query(`CREATE DATABASE "${safeDbName}"`);
            console.log(`[Database] Database '${safeDbName}' created successfully.`);
        }
        await adminClient.end();
    } catch (err) {
        console.warn(`[Database] Root postgres connection check failed: ${err.message}`);
        try { await adminClient.end(); } catch (_) {}
    }

    // 2. Connect pool to target database
    try {
        if (pool) {
            try { await pool.end(); } catch (_) {}
        }

        pool = new Pool(DB_CONFIG);

        // Verify pool connection & get version
        const res = await pool.query('SELECT version()');
        dbStatus.connected = true;
        dbStatus.version = res.rows[0]?.version || 'PostgreSQL';
        dbStatus.error = null;
        console.log(`[Database] Connected to PostgreSQL '${DB_CONFIG.database}' on ${DB_CONFIG.host}:${DB_CONFIG.port}`);

        // 3. Apply schema.sql
        const schemaPath = path.join(__dirname, 'schema.sql');
        if (fs.existsSync(schemaPath)) {
            const schemaSql = fs.readFileSync(schemaPath, 'utf8');
            await pool.query(schemaSql);
            console.log(`[Database] Relational schema verified & tables migrated successfully.`);
        }

        // 4. Seed multi-tenant foundation (Superadmin, Org, Project)
        await seedMultiTenantDefaults();

        return true;
    } catch (err) {
        dbStatus.connected = false;
        dbStatus.error = err.message;
        console.error(`[Database] Could not connect to database '${DB_CONFIG.database}':`, err.message);
        console.warn(`[Database] Application running in resilient fallback mode (local file storage).`);
        return false;
    }
}

/**
 * Execute a query with parameters against the pool.
 */
async function query(text, params) {
    if (!pool || !dbStatus.connected) {
        throw new Error('Database is not connected');
    }
    return pool.query(text, params);
}

/**
 * Get a client from the pool for transactions.
 */
async function getClient() {
    if (!pool || !dbStatus.connected) {
        throw new Error('Database is not connected');
    }
    return pool.connect();
}

/**
 * Get current DB health/status.
 */
function getDbStatus() {
    return { ...dbStatus, lastChecked: new Date().toISOString() };
}

module.exports = {
    initDatabase,
    seedMultiTenantDefaults,
    query,
    getClient,
    getDbStatus,
    DB_CONFIG
};
