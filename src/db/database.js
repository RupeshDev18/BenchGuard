const { Pool, Client } = require('pg');
const fs = require('fs');
const path = require('path');

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
            // datname cannot be parameterized in CREATE DATABASE
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
    query,
    getClient,
    getDbStatus,
    DB_CONFIG
};
