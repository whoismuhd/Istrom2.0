import test from 'node:test';
import assert from 'node:assert/strict';
import { requestActivity, buildDailyTrend, buildHeatmapMatrix } from './activity.js';

test('Dashboard activity counts all requests independently of notifications', () => {
  const now = new Date().toISOString();
  const requests = Array.from({ length: 150 }, (_, id) => ({ id, created_at: now, updated_at: now, status: id < 5 ? 'Approved' : 'Pending' }));
  const trend = buildDailyTrend(requestActivity(requests));
  assert.equal(trend.reduce((sum, row) => sum + row.incoming, 0), 150);
  assert.equal(trend.reduce((sum, row) => sum + row.approved, 0), 5);
});
test('Weekly heatmap excludes old requests and reversed approvals', () => {
  const activity = requestActivity([
    { created_at: '2020-01-01T12:00:00', updated_at: '2020-01-01T12:00:00', status: 'Approved' },
    { created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: 'Pending' },
  ]);
  assert.equal(activity.filter((a) => a.notification_type === 'request_approved').length, 1);
  assert.equal(buildHeatmapMatrix(activity).flat().reduce((sum, value) => sum + value, 0), 1);
});
