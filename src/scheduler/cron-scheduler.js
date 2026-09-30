/**
 * cron-scheduler.js
 * Multi-Tenant Automated Benchmark & Regression Test Scheduler
 * Uses node-cron to trigger isolated k6 performance runs on recurring intervals.
 */

const cron = require('node-cron');
const { query } = require('../db/database');
const { startProjectPipeline, isProjectPipelineRunning } = require('../execution/project-executor');

const activeCronJobs = new Map(); // scheduleId -> cronTask

/**
 * Executes a single scheduled run.
 */
async function executeScheduledRun(scheduleId) {
    try {
        const schRes = await query(
            `SELECT s.*, p.org_id, p.name as project_name, e.name as env_name
             FROM project_schedules s
             JOIN projects p ON s.project_id = p.id
             LEFT JOIN project_environments e ON s.environment_id = e.id
             WHERE s.id = $1 AND s.is_active = TRUE`,
            [scheduleId]
        );

        if (schRes.rows.length === 0) {
            console.log(`[Scheduler] Schedule ${scheduleId} is inactive or removed.`);
            unregisterSchedule(scheduleId);
            return;
        }

        const schedule = schRes.rows[0];

        if (isProjectPipelineRunning(schedule.project_id)) {
            console.warn(`[Scheduler] Skipping scheduled run '${schedule.name}': A pipeline is already active for project ${schedule.project_id}.`);
            await query(
                `UPDATE project_schedules SET last_run_status = 'skipped_concurrent' WHERE id = $1`,
                [scheduleId]
            );
            return;
        }

        console.log(`\n⏰ [Scheduler] Triggering scheduled benchmark: '${schedule.name}' for project '${schedule.project_name}'...`);

        await query(
            `UPDATE project_schedules SET last_run_at = CURRENT_TIMESTAMP, last_run_status = 'running' WHERE id = $1`,
            [scheduleId]
        );

        const duration = schedule.duration_sec || 10;
        const peakVus = schedule.peak_vus || 20;

        await startProjectPipeline({
            projectId: schedule.project_id,
            orgId: schedule.org_id,
            environmentName: schedule.env_name || 'staging',
            stages: [
                { duration: `${Math.max(3, Math.round(duration * 0.7))}s`, target: peakVus },
                { duration: `${Math.max(2, Math.round(duration * 0.3))}s`, target: 0 }
            ],
            peakVus: peakVus,
            thresholds: {
                p95Ms: schedule.p95_threshold_ms || 500,
                p99Ms: 1000,
                maxErrorRate: parseFloat(schedule.max_error_rate_pct) || 1.0
            },
            buildLabel: `cron-${schedule.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
            triggeredBy: schedule.created_by,
            scheduleId: schedule.id
        });

    } catch (err) {
        console.error(`[Scheduler] Error running schedule ${scheduleId}: ${err.message}`);
        await query(
            `UPDATE project_schedules SET last_run_status = 'error' WHERE id = $1`,
            [scheduleId]
        ).catch(() => {});
    }
}

/**
 * Registers an active schedule into node-cron.
 */
function registerSchedule(schedule) {
    if (!schedule || !schedule.cron_expression) return false;

    if (!cron.validate(schedule.cron_expression)) {
        console.warn(`[Scheduler] Invalid cron expression '${schedule.cron_expression}' for schedule '${schedule.name}'.`);
        return false;
    }

    // Stop existing if any
    unregisterSchedule(schedule.id);

    try {
        const task = cron.schedule(schedule.cron_expression, () => {
            executeScheduledRun(schedule.id);
        });
        activeCronJobs.set(schedule.id, task);
        return true;
    } catch (e) {
        console.error(`[Scheduler] Failed scheduling job ${schedule.id}: ${e.message}`);
        return false;
    }
}

/**
 * Unregisters and stops a running schedule.
 */
function unregisterSchedule(scheduleId) {
    if (activeCronJobs.has(scheduleId)) {
        try {
            const task = activeCronJobs.get(scheduleId);
            task.stop();
        } catch (_) {}
        activeCronJobs.delete(scheduleId);
    }
}

/**
 * Initializes and starts all active project schedules from database.
 */
async function initScheduler() {
    try {
        const activeRes = await query(
            `SELECT * FROM project_schedules WHERE is_active = TRUE`
        );
        let registeredCount = 0;
        for (const schedule of activeRes.rows) {
            if (registerSchedule(schedule)) {
                registeredCount++;
            }
        }
        console.log(`[Scheduler] Background cron engine initialized with ${registeredCount} active benchmark schedules.`);
    } catch (err) {
        console.warn(`[Scheduler] Could not initialize schedules: ${err.message}`);
    }
}

module.exports = {
    initScheduler,
    registerSchedule,
    unregisterSchedule,
    executeScheduledRun
};
