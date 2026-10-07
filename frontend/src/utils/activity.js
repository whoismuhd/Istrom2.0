import { parseApiDate } from './dates.js';

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function isSameDay(dateStr) {
  if (!dateStr) return false;
  const date = parseApiDate(dateStr);
  if (Number.isNaN(date.getTime())) return false;
  return date.toDateString() === new Date().toDateString();
}

function toDayKey(date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function buildDailyTrend(events, days = 7) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const rows = [];
  const lookup = new Map();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = toDayKey(d);
    const row = {
      key,
      label: WEEKDAY_LABELS[(d.getDay() + 6) % 7],
      incoming: 0,
      approved: 0,
      rejected: 0,
      total: 0,
    };
    rows.push(row);
    lookup.set(key, row);
  }

  for (const n of events) {
    if (!n?.created_at) continue;
    const d = parseApiDate(n.created_at);
    if (Number.isNaN(d.getTime())) continue;
    d.setHours(0, 0, 0, 0);
    const row = lookup.get(toDayKey(d));
    if (!row) continue;
    if (n.notification_type === 'new_request') row.incoming += 1;
    if (n.notification_type === 'request_approved') row.approved += 1;
    if (n.notification_type === 'request_rejected') row.rejected += 1;
    row.total += 1;
  }
  return rows;
}

export function buildHeatmapMatrix(events) {
  const matrix = Array.from({ length: 7 }, () => Array(4).fill(0));
  for (const n of events) {
    if (!n?.created_at) continue;
    if (!['new_request', 'request_approved', 'request_rejected'].includes(n.notification_type)) continue;
    const d = parseApiDate(n.created_at);
    if (Number.isNaN(d.getTime())) continue;
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - 6);
    if (d < cutoff || d > new Date()) continue;
    const weekday = (d.getDay() + 6) % 7;
    const hour = d.getHours();
    const slot = hour < 6 ? 0 : hour < 12 ? 1 : hour < 18 ? 2 : 3;
    matrix[weekday][slot] += 1;
  }
  return matrix;
}

export function requestActivity(requests) {
  return requests.flatMap((r) => [
    { created_at: r.created_at, notification_type: 'new_request' },
    ...(r.status === 'Approved' || r.status === 'Rejected' ? [{ created_at: r.updated_at, notification_type: r.status === 'Approved' ? 'request_approved' : 'request_rejected' }] : []),
  ]);
}
