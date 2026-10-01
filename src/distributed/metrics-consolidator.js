/**
 * metrics-consolidator.js
 *
 * Consolidates multiple k6 worker summaries into a single unified summary
 * matching the standard k6 JSON summary schema.
 */

function mergeMetrics(workerSummaries) {
  if (!workerSummaries || workerSummaries.length === 0) {
    return {};
  }
  if (workerSummaries.length === 1) {
    return workerSummaries[0];
  }

  const consolidated = JSON.parse(JSON.stringify(workerSummaries[0]));
  const metrics = consolidated.metrics || {};

  // Extract helper for metric values
  const getVals = (summary, metricName) => {
    const m = summary.metrics?.[metricName];
    if (!m) return null;
    return m.values ? { ...m.values } : { ...m };
  };

  // 1. Consolidate Total HTTP Requests (Counter)
  let totalReqs = 0;
  let totalReqsRate = 0;
  workerSummaries.forEach((s) => {
    const vals = getVals(s, "http_reqs");
    if (vals) {
      totalReqs += Number(vals.count || 0);
      totalReqsRate += Number(vals.rate || 0);
    }
  });

  if (metrics.http_reqs) {
    if (metrics.http_reqs.values) {
      metrics.http_reqs.values.count = totalReqs;
      metrics.http_reqs.values.rate = Number(totalReqsRate.toFixed(2));
    } else {
      metrics.http_reqs.count = totalReqs;
      metrics.http_reqs.rate = Number(totalReqsRate.toFixed(2));
    }
  }

  // 2. Consolidate HTTP Request Failed (Rate)
  let failedPasses = 0;
  let failedFails = 0;
  workerSummaries.forEach((s) => {
    const vals = getVals(s, "http_req_failed");
    if (vals) {
      failedPasses += Number(vals.passes || 0);
      failedFails += Number(vals.fails || 0);
    }
  });
  const totalAttempts = failedPasses + failedFails;
  const failRate = totalAttempts > 0 ? failedPasses / totalAttempts : 0;

  if (metrics.http_req_failed) {
    const target = metrics.http_req_failed.values || metrics.http_req_failed;
    target.passes = failedPasses;
    target.fails = failedFails;
    target.value = failRate;
    target.rate = failRate;
  }

  // 3. Consolidate Data Sent & Received (Counter)
  ["data_sent", "data_received"].forEach((mName) => {
    let sumCount = 0;
    let sumRate = 0;
    workerSummaries.forEach((s) => {
      const vals = getVals(s, mName);
      if (vals) {
        sumCount += Number(vals.count || 0);
        sumRate += Number(vals.rate || 0);
      }
    });
    if (metrics[mName]) {
      const target = metrics[mName].values || metrics[mName];
      target.count = sumCount;
      target.rate = Number(sumRate.toFixed(2));
    }
  });

  // 4. Consolidate VUs & Concurrency (Gauge)
  let sumVUs = 0;
  let sumMaxVUs = 0;
  workerSummaries.forEach((s) => {
    const vVals = getVals(s, "vus");
    if (vVals) sumVUs += Number(vVals.value || 0);
    const maxVals = getVals(s, "vus_max");
    if (maxVals) sumMaxVUs += Number(maxVals.value || maxVals.max || 0);
  });

  if (metrics.vus) {
    const target = metrics.vus.values || metrics.vus;
    target.value = sumVUs;
    target.min = 0;
    target.max = sumMaxVUs;
  }
  if (metrics.vus_max) {
    const target = metrics.vus_max.values || metrics.vus_max;
    target.value = sumMaxVUs;
    target.max = sumMaxVUs;
  }

  // 5. Consolidate HTTP Request Duration & Latencies (Trend)
  const durationWeights = [];
  let minLat = Infinity;
  let maxLat = -Infinity;

  workerSummaries.forEach((s) => {
    const dVals = getVals(s, "http_req_duration");
    const rVals = getVals(s, "http_reqs");
    const weight = rVals ? Number(rVals.count || 1) : 1;
    if (dVals) {
      durationWeights.push({ dVals, weight });
      if (dVals.min !== undefined && dVals.min < minLat) minLat = dVals.min;
      if (dVals.max !== undefined && dVals.max > maxLat) maxLat = dVals.max;
    }
  });

  if (durationWeights.length > 0 && metrics.http_req_duration) {
    const target = metrics.http_req_duration.values || metrics.http_req_duration;
    const totalWeight = durationWeights.reduce((acc, curr) => acc + curr.weight, 0) || 1;

    const weighted = (key) => {
      const sum = durationWeights.reduce((acc, curr) => acc + (Number(curr.dVals[key] || 0) * curr.weight), 0);
      return Number((sum / totalWeight).toFixed(2));
    };

    target.avg = weighted("avg");
    target.med = weighted("med");
    target["p(90)"] = weighted("p(90)");
    target["p(95)"] = weighted("p(95)");
    target["p(99)"] = weighted("p(99)");
    target.min = minLat !== Infinity ? minLat : 0;
    target.max = maxLat !== -Infinity ? maxLat : 0;
  }

  // 6. Record metadata indicating distributed execution
  consolidated.benchguardDistributed = {
    workerCount: workerSummaries.length,
    consolidatedAt: new Date().toISOString(),
    totalRequests: totalReqs,
    aggregatedRps: totalReqsRate
  };

  return consolidated;
}

module.exports = { mergeMetrics };
