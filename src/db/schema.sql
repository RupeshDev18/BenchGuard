-- ==========================================================================
-- k6 & Allure Performance Studio - PostgreSQL Multi-Tenant Relational Schema
-- ==========================================================================

-- Enable pgcrypto for UUID generation if available
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Organizations Table (Tenants)
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(150) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    plan_tier VARCHAR(50) DEFAULT 'free', -- 'free', 'team', 'enterprise'
    max_vus_allowed INT DEFAULT 100,
    max_projects INT DEFAULT 5,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Users Table (Identity & Authentication)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    is_superadmin BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Organization Members Table (RBAC Mapping)
CREATE TABLE IF NOT EXISTS organization_members (
    id SERIAL PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'developer', -- 'admin', 'developer', 'viewer'
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(org_id, user_id)
);

-- 4. Projects Table (Organization Scoped)
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    slug VARCHAR(100) NOT NULL,
    description TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(org_id, slug)
);

-- 5. Project Environments Table (Dev, Staging, Production targets)
CREATE TABLE IF NOT EXISTS project_environments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL, -- 'development', 'staging', 'production'
    base_url TEXT NOT NULL DEFAULT 'http://localhost:8080',
    default_headers JSONB DEFAULT '{}',
    auth_config JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Project OpenAPI Specifications
CREATE TABLE IF NOT EXISTS project_specs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL DEFAULT 'Default API Spec',
    version VARCHAR(50) DEFAULT '1.0.0',
    format VARCHAR(50) DEFAULT 'OpenAPI 3.0',
    raw_content JSONB NOT NULL DEFAULT '{}',
    endpoint_configs JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT TRUE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Project Datasets Table (Parameterization files)
CREATE TABLE IF NOT EXISTS project_datasets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL,
    row_count INT DEFAULT 0,
    columns JSONB DEFAULT '[]',
    preview_data JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Test Runs Table (Primary execution records)
CREATE TABLE IF NOT EXISTS test_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_number SERIAL,
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    environment_id UUID REFERENCES project_environments(id) ON DELETE SET NULL,
    triggered_by UUID REFERENCES users(id) ON DELETE SET NULL,
    build_label VARCHAR(100) NOT NULL DEFAULT 'v1.0.0',
    environment VARCHAR(50) NOT NULL DEFAULT 'staging',
    target_base_url TEXT NOT NULL DEFAULT 'http://localhost:8080',
    spec_title VARCHAR(255) DEFAULT 'OpenAPI Specification',
    spec_version VARCHAR(50) DEFAULT '1.0.0',
    spec_format VARCHAR(50) DEFAULT 'OpenAPI 3.0',
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    duration_seconds NUMERIC(10, 2) DEFAULT 0,
    exit_code INT DEFAULT 0,
    passed BOOLEAN DEFAULT TRUE,
    sla_verdict VARCHAR(20) DEFAULT 'PASSED',
    peak_vus INT DEFAULT 0,
    total_requests BIGINT DEFAULT 0,
    failed_requests BIGINT DEFAULT 0,
    error_rate NUMERIC(6, 3) DEFAULT 0,
    throughput_rps NUMERIC(10, 2) DEFAULT 0,
    p95_latency_ms NUMERIC(10, 2) DEFAULT 0,
    p99_latency_ms NUMERIC(10, 2) DEFAULT 0,
    avg_latency_ms NUMERIC(10, 2) DEFAULT 0,
    med_latency_ms NUMERIC(10, 2) DEFAULT 0,
    max_latency_ms NUMERIC(10, 2) DEFAULT 0,
    config_snapshot JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent column additions for existing test_runs table
ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS environment_id UUID REFERENCES project_environments(id) ON DELETE SET NULL;
ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS triggered_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- 9. Aggregated Endpoint Run Metrics
CREATE TABLE IF NOT EXISTS endpoint_run_metrics (
    id SERIAL PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
    op_id VARCHAR(255) NOT NULL,
    method VARCHAR(10) NOT NULL,
    route TEXT NOT NULL,
    tag VARCHAR(100) DEFAULT 'General',
    request_count BIGINT DEFAULT 0,
    failure_count BIGINT DEFAULT 0,
    error_rate NUMERIC(6, 3) DEFAULT 0,
    p90_ms NUMERIC(10, 2) DEFAULT 0,
    p95_ms NUMERIC(10, 2) DEFAULT 0,
    p99_ms NUMERIC(10, 2) DEFAULT 0,
    avg_ms NUMERIC(10, 2) DEFAULT 0,
    min_ms NUMERIC(10, 2) DEFAULT 0,
    max_ms NUMERIC(10, 2) DEFAULT 0,
    threshold_breached BOOLEAN DEFAULT FALSE,
    expected_status_codes INT[]
);

-- 10. Run Timeseries (Second-by-second plot points for dynamic graphs)
CREATE TABLE IF NOT EXISTS run_timeseries (
    id BIGSERIAL PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
    second_offset INT NOT NULL,
    active_vus INT DEFAULT 0,
    throughput_rps NUMERIC(10, 2) DEFAULT 0,
    p95_latency_ms NUMERIC(10, 2) DEFAULT 0,
    errors_per_second NUMERIC(10, 2) DEFAULT 0
);

-- 11. Contract Test Results (Schemathesis schema compliance)
CREATE TABLE IF NOT EXISTS contract_test_results (
    id SERIAL PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    method VARCHAR(10) NOT NULL,
    check_name VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL, -- PASS, FAIL, SKIP
    failure_reason TEXT,
    reproduction_curl TEXT,
    violation_details JSONB
);

-- 12. Indexes for fast dashboards, regression queries, and multi-tenant isolation
CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org ON organization_members(org_id);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
CREATE INDEX IF NOT EXISTS idx_project_envs_project ON project_environments(project_id);
CREATE INDEX IF NOT EXISTS idx_project_specs_project ON project_specs(project_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_project ON test_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_org ON test_runs(org_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_created_at ON test_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_endpoint_metrics_run_id ON endpoint_run_metrics(run_id);
CREATE INDEX IF NOT EXISTS idx_run_timeseries_run_sec ON run_timeseries(run_id, second_offset);
CREATE INDEX IF NOT EXISTS idx_contract_results_run_id ON contract_test_results(run_id);

-- 13. Scheduled Automated Benchmarks (Recurring Cron Jobs per project)
CREATE TABLE IF NOT EXISTS project_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    environment_id UUID REFERENCES project_environments(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    cron_expression VARCHAR(64) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    peak_vus INT NOT NULL DEFAULT 20,
    duration_sec INT NOT NULL DEFAULT 10,
    p95_threshold_ms INT NOT NULL DEFAULT 500,
    max_error_rate_pct NUMERIC(5,2) NOT NULL DEFAULT 1.0,
    last_run_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ,
    last_run_status VARCHAR(32) DEFAULT 'pending',
    last_run_id UUID REFERENCES test_runs(id) ON DELETE SET NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 14. Project Webhooks (Alerting for Slack, Teams, Discord, custom APM)
CREATE TABLE IF NOT EXISTS project_webhooks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL DEFAULT 'Webhook Alert',
    url VARCHAR(1024) NOT NULL,
    events JSONB NOT NULL DEFAULT '["run.completed", "sla.failed"]'::jsonb,
    secret VARCHAR(255),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_dispatched_at TIMESTAMPTZ,
    last_status_code INT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_project_schedules_project ON project_schedules(project_id);
CREATE INDEX IF NOT EXISTS idx_project_schedules_active ON project_schedules(is_active);
CREATE INDEX IF NOT EXISTS idx_project_webhooks_project ON project_webhooks(project_id);
