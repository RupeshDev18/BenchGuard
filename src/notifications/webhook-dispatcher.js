/**
 * webhook-dispatcher.js
 * Multi-tenant Alerting & Notification Dispatcher
 * Dispatches automated alerts to Slack, Discord, Microsoft Teams, and custom APM endpoints.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { query } = require('../db/database');

/**
 * Sends an HTTP/HTTPS POST request with JSON payload.
 */
function sendHttpRequest(targetUrl, payload, secret = null) {
    return new Promise((resolve) => {
        try {
            const urlObj = new URL(targetUrl);
            const client = urlObj.protocol === 'https:' ? https : http;
            const dataString = JSON.stringify(payload);

            const headers = {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(dataString),
                'User-Agent': 'k6-Performance-Studio-Webhook/1.0'
            };

            if (secret) {
                const signature = crypto.createHmac('sha256', secret).update(dataString).digest('hex');
                headers['X-Signature-SHA256'] = signature;
            }

            const req = client.request(urlObj, {
                method: 'POST',
                headers,
                timeout: 6000
            }, (res) => {
                let responseBody = '';
                res.on('data', chunk => responseBody += chunk);
                res.on('end', () => {
                    resolve({
                        success: res.statusCode >= 200 && res.statusCode < 300,
                        statusCode: res.statusCode,
                        body: responseBody.slice(0, 500)
                    });
                });
            });

            req.on('error', (err) => {
                resolve({ success: false, statusCode: 0, error: err.message });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({ success: false, statusCode: 408, error: 'Request Timeout (6s)' });
            });

            req.write(dataString);
            req.end();
        } catch (e) {
            resolve({ success: false, statusCode: 0, error: e.message });
        }
    });
}

/**
 * Builds a Slack-formatted payload if target is a Slack webhook.
 */
function formatSlackPayload(event, data) {
    const isSuccess = data.verdict === 'PASSED';
    const color = isSuccess ? '#28a745' : '#dc3545';
    const statusEmoji = isSuccess ? '✅ PASSED' : '❌ FAILED';

    return {
        attachments: [
            {
                color,
                title: `[k6 Studio] Benchmark ${statusEmoji}: ${data.projectName || 'Performance Test'}`,
                title_link: data.reportUrl || undefined,
                text: `*Run Number:* #${data.runNumber || 'N/A'} | *Environment:* ${data.environment || 'staging'} | *Event:* \`${event}\``,
                fields: [
                    { title: 'Throughput', value: `${data.throughputRps || 0} req/s`, short: true },
                    { title: 'p95 Latency', value: `${data.p95LatencyMs || 0} ms`, short: true },
                    { title: 'Error Rate', value: `${data.errorRatePct || 0}%`, short: true },
                    { title: 'Peak VUs', value: `${data.peakVus || 0} VUs`, short: true }
                ],
                footer: 'k6 & Allure Performance Studio Multi-Tenant SaaS',
                ts: Math.floor(Date.now() / 1000)
            }
        ]
    };
}

/**
 * Dispatches an event to all active webhooks subscribed for this project.
 * @param {string} projectId 
 * @param {string} event e.g. "run.completed", "sla.failed"
 * @param {object} eventData run metrics and links
 */
async function dispatchProjectWebhooks(projectId, event, eventData) {
    try {
        const whRes = await query(
            `SELECT * FROM project_webhooks WHERE project_id = $1 AND is_active = TRUE`,
            [projectId]
        );

        if (whRes.rows.length === 0) return [];

        const results = [];
        for (const wh of whRes.rows) {
            let eventsSubscribed = [];
            try {
                eventsSubscribed = typeof wh.events === 'string' ? JSON.parse(wh.events) : wh.events;
            } catch (_) {
                eventsSubscribed = ['run.completed', 'sla.failed'];
            }

            if (!eventsSubscribed.includes(event) && !eventsSubscribed.includes('*')) {
                continue;
            }

            const isSlack = wh.url.includes('hooks.slack.com') || wh.url.includes('slack');
            const payload = isSlack
                ? formatSlackPayload(event, eventData)
                : {
                    event,
                    timestamp: new Date().toISOString(),
                    projectId,
                    data: eventData
                };

            const outcome = await sendHttpRequest(wh.url, payload, wh.secret);

            // Record outcome
            await query(
                `UPDATE project_webhooks 
                 SET last_dispatched_at = CURRENT_TIMESTAMP, last_status_code = $1 
                 WHERE id = $2`,
                [outcome.statusCode || (outcome.success ? 200 : 500), wh.id]
            );

            results.push({
                webhookId: wh.id,
                name: wh.name,
                url: wh.url,
                ...outcome
            });
        }
        return results;
    } catch (err) {
        console.warn(`[WebhookDispatcher] Error dispatching webhooks for project ${projectId}: ${err.message}`);
        return [];
    }
}

/**
 * Tests an arbitrary webhook URL with a verification ping.
 */
async function testWebhookPing(targetUrl, secret = null) {
    const testPayload = {
        event: 'webhook.ping',
        timestamp: new Date().toISOString(),
        message: 'k6 Performance Testing & Allure Studio webhook verification ping.',
        status: 'OK'
    };
    return await sendHttpRequest(targetUrl, testPayload, secret);
}

module.exports = {
    dispatchProjectWebhooks,
    testWebhookPing
};
