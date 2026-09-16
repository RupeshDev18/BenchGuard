-- ==========================================================================
-- k6 & Allure Performance Studio - PostgreSQL Relational Schema
-- ==========================================================================

-- Enable pgcrypto for UUID generation if available
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Test Runs Table (Primary execution records)
CREATE TABLE IF NOT EXISTS test_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_number SERIAL,
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

-- 2. Aggregated Endpoint Run Metrics
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

-- 3. Run Timeseries (Second-by-second plot points for dynamic graphs)
CREATE TABLE IF NOT EXISTS run_timeseries (
    id BIGSERIAL PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
    second_offset INT NOT NULL,
    active_vus INT DEFAULT 0,
    throughput_rps NUMERIC(10, 2) DEFAULT 0,
    p95_latency_ms NUMERIC(10, 2) DEFAULT 0,
    errors_per_second NUMERIC(10, 2) DEFAULT 0
);

-- 4. Contract Test Results (Schemathesis schema compliance)
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

-- 5. Indexes for fast dashboards, regression queries, and timeseries charts
CREATE INDEX IF NOT EXISTS idx_test_runs_created_at ON test_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_runs_env_build ON test_runs(environment, build_label);
CREATE INDEX IF NOT EXISTS idx_endpoint_metrics_run_id ON endpoint_run_metrics(run_id);
CREATE INDEX IF NOT EXISTS idx_run_timeseries_run_sec ON run_timeseries(run_id, second_offset);
CREATE INDEX IF NOT EXISTS idx_contract_results_run_id ON contract_test_results(run_id);
