import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import { api, formatDate, formatNaira } from '../api';
import './Dashboard.css';

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HEATMAP_BLOCKS = ['00-06', '06-12', '12-18', '18-24'];

function isSameDay(dateStr) {
  if (!dateStr) return false;
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return false;
  return date.toDateString() === new Date().toDateString();
}

function toDayKey(date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function buildDailyTrend(notifications, days = 7) {
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

  for (const n of notifications) {
    if (!n?.created_at) continue;
    const d = new Date(n.created_at);
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

function buildHeatmapMatrix(notifications) {
  const matrix = Array.from({ length: 7 }, () => Array(4).fill(0));
  for (const n of notifications) {
    if (!n?.created_at) continue;
    if (!['new_request', 'request_approved', 'request_rejected'].includes(n.notification_type)) continue;
    const d = new Date(n.created_at);
    if (Number.isNaN(d.getTime())) continue;
    const weekday = (d.getDay() + 6) % 7;
    const hour = d.getHours();
    const slot = hour < 6 ? 0 : hour < 12 ? 1 : hour < 18 ? 2 : 3;
    matrix[weekday][slot] += 1;
  }
  return matrix;
}

export default function Dashboard() {
  const { user, isGlobalAdmin, getEffectiveProjectSite } = useAuth();
  const isSiteAdmin = user?.user_type === 'admin' && !isGlobalAdmin;
  const effectiveSite = getEffectiveProjectSite();
  const siteParams = effectiveSite ? { project_site: effectiveSite } : {};

  const { data: items = [] } = useQuery({
    queryKey: ['dashboard', 'items', siteParams],
    queryFn: () => api.items.list(siteParams),
  });

  const { data: requests = [] } = useQuery({
    queryKey: ['dashboard', 'requests', siteParams],
    queryFn: () => api.requests.list(siteParams),
  });

  const { data: notifications = [] } = useQuery({
    queryKey: ['dashboard', 'notifications'],
    queryFn: () => api.notifications.list(),
  });

  const { data: sites = [] } = useQuery({
    queryKey: ['dashboard', 'projectSites'],
    queryFn: () => api.projectSites.list(),
    enabled: isGlobalAdmin,
  });

  const totalStockValue = items.reduce((sum, item) => sum + (item.qty || 0) * (item.unit_cost || 0), 0);
  const pendingRequests = requests.filter((r) => r.status === 'Pending').length;
  const approvedRequests = requests.filter((r) => r.status === 'Approved').length;
  const rejectedRequests = requests.filter((r) => r.status === 'Rejected').length;
  const unreadNotifications = notifications.filter((n) => !n.is_read).length;
  const lowStockCount = items.filter((item) => Number(item.qty || 0) <= 5).length;
  const approvedToday = notifications.filter(
    (n) => n.notification_type === 'request_approved' && isSameDay(n.created_at)
  ).length;
  const submittedToday = notifications.filter(
    (n) => n.notification_type === 'request_submitted' && isSameDay(n.created_at)
  ).length;

  const topPending = requests
    .filter((r) => r.status === 'Pending')
    .slice(0, 5);

  const quickLinks = isGlobalAdmin
    ? [
        { to: '/review', title: 'Approve Requests', desc: 'Review pending requests and process approvals quickly.' },
        // { to: '/bulk-upload', title: 'Excel Viewer', desc: 'Upload and inspect Excel/CSV files without changing inventory.' },
        { to: '/inventory', title: 'Inventory Oversight', desc: 'Track stock health and category-level value trends.' },
        { to: '/budget-summary', title: 'Budget Intelligence', desc: 'Analyze budget totals and building-type breakdowns.' },
        { to: '/settings', title: 'System Settings', desc: 'Manage project sites, access codes, logs, and notifications.' },
      ]
    : isSiteAdmin
      ? [
          { to: '/request', title: 'Create Request', desc: 'Submit material and labour requests from site operations.' },
          // { to: '/bulk-upload', title: 'Excel Viewer', desc: 'Upload and view site spreadsheets without importing any rows.' },
          { to: '/inventory', title: 'Site Inventory', desc: 'Track available stock and monitor low-quantity items.' },
          { to: '/review', title: 'Request Status', desc: 'Follow pending, approved, and rejected request outcomes.' },
        ]
      : [
        { to: '/request', title: 'Create Request', desc: 'Submit material and labour requests from site operations.' },
        { to: '/inventory', title: 'Site Inventory', desc: 'Track available stock and monitor low-quantity items.' },
        // { to: '/bulk-upload', title: 'Excel Viewer', desc: 'Upload and inspect spreadsheet files without importing any data.' },
        { to: '/notifications', title: 'Notification Center', desc: 'Stay updated on submissions, approvals, and rejections.' },
      ];

  const roleLabel = isGlobalAdmin ? 'Global Admin' : (user?.user_type === 'admin' ? 'Site Admin' : 'Project Site User');
  const scopeLabel = isGlobalAdmin ? (effectiveSite || 'All Project Sites') : (user?.project_site || 'Unassigned Site');

  const adminPipeline = [
    { label: 'Incoming', tone: 'incoming', value: notifications.filter((n) => n.notification_type === 'new_request').length },
    { label: 'Pending', tone: 'pending', value: pendingRequests },
    { label: 'Approved', tone: 'approved', value: approvedRequests },
    { label: 'Rejected', tone: 'rejected', value: rejectedRequests },
  ];
  const adminPipelinePeak = Math.max(1, ...adminPipeline.map((stage) => stage.value));
  const approvalRate = approvedRequests + rejectedRequests > 0
    ? Math.round((approvedRequests / (approvedRequests + rejectedRequests)) * 100)
    : 0;

  const adminTrend = buildDailyTrend(notifications, 7);
  const adminTrendPeak = Math.max(
    1,
    ...adminTrend.map((day) => Math.max(day.incoming, day.approved, day.rejected))
  );

  const heatmap = buildHeatmapMatrix(notifications);
  const heatmapPeak = Math.max(1, ...heatmap.flat());

  return (
    <div className={`dashboard-page ${isGlobalAdmin ? 'dashboard-admin' : 'dashboard-site'}`}>
      <div className="card dashboard-hero">
        <div className="dashboard-hero-main">
          <div>
            <span className="dashboard-role-badge">{roleLabel}</span>
            <h2 className="dashboard-title">
              {isGlobalAdmin ? 'Admin Control Tower' : 'Site Operations Hub'}
            </h2>
            <p className="dashboard-caption">
              {isGlobalAdmin
                ? 'Centralized command view for approvals, budgets, and multi-site inventory control.'
                : 'Operational view for day-to-day inventory execution, requests, and site delivery flow.'}
            </p>
          </div>
          <div className="dashboard-scope">
            <span className="dashboard-scope-label">Current Scope</span>
            <span className="dashboard-scope-value">{scopeLabel}</span>
          </div>
        </div>

        <div className="dashboard-kpi-grid">
          <div className="dashboard-kpi">
            <span className="dashboard-kpi-label">{isGlobalAdmin ? 'Active Sites' : 'Site Inventory Items'}</span>
            <span className="dashboard-kpi-value">{isGlobalAdmin ? sites.length : items.length}</span>
          </div>
          <div className="dashboard-kpi">
            <span className="dashboard-kpi-label">Pending Requests</span>
            <span className="dashboard-kpi-value">{pendingRequests}</span>
          </div>
          <div className="dashboard-kpi">
            <span className="dashboard-kpi-label">{isGlobalAdmin ? 'Approvals Today' : 'Submissions Today'}</span>
            <span className="dashboard-kpi-value">{isGlobalAdmin ? approvedToday : submittedToday}</span>
          </div>
          <div className="dashboard-kpi">
            <span className="dashboard-kpi-label">Unread Alerts</span>
            <span className="dashboard-kpi-value">{unreadNotifications}</span>
          </div>
          <div className="dashboard-kpi">
            <span className="dashboard-kpi-label">Low Stock Items</span>
            <span className="dashboard-kpi-value">{lowStockCount}</span>
          </div>
          <div className="dashboard-kpi">
            <span className="dashboard-kpi-label">Stock Value</span>
            <span className="dashboard-kpi-value">{formatNaira(totalStockValue)}</span>
          </div>
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="card">
          <h3>Priority Queue</h3>
          <p className="caption">
            {isGlobalAdmin
              ? 'Most recent pending approvals requiring attention.'
              : 'Recent pending requests from your site queue.'}
          </p>
          <div className="dashboard-mini-metrics">
            <div className="dashboard-mini-metric">
              <span>Approved</span>
              <strong>{approvedRequests}</strong>
            </div>
            <div className="dashboard-mini-metric">
              <span>Rejected</span>
              <strong>{rejectedRequests}</strong>
            </div>
          </div>
          {topPending.length === 0 ? (
            <p className="dashboard-empty">No pending requests right now.</p>
          ) : (
            <div className="dashboard-list">
              {topPending.map((req) => (
                <div key={req.id} className="dashboard-list-item">
                  <div>
                    <strong>{req.item_name || `Item #${req.item_id}`}</strong>
                    <p>
                      Qty: {req.qty} | Requested by: {req.requested_by}
                    </p>
                  </div>
                  <span className="badge badge-pending">{req.status}</span>
                </div>
              ))}
            </div>
          )}
          <Link className="btn btn-secondary" to="/review">
            Open Review & History
          </Link>
        </div>

        <div className="card">
          <h3>Quick Actions</h3>
          <p className="caption">
            {isGlobalAdmin
              ? 'Navigate to administration and oversight workflows.'
              : 'Jump into site operations and fulfillment workflows.'}
          </p>
          <div className="dashboard-actions">
            {quickLinks.map((link) => (
              <Link key={link.to} to={link.to} className="dashboard-action-link">
                <span className="dashboard-action-title">{link.title}</span>
                <span className="dashboard-action-desc">{link.desc}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>

      {isGlobalAdmin && (
        <div className="dashboard-grid dashboard-grid-analytics">
          <div className="card">
            <div className="dashboard-section-head">
              <h3>Approval Pipeline</h3>
              <span className="dashboard-section-chip">Approval Rate {approvalRate}%</span>
            </div>
            <p className="caption">
              Executive funnel view of request flow and approval outcomes for your current scope.
            </p>

            <div className="dashboard-pipeline">
              {adminPipeline.map((stage) => (
                <div key={stage.label} className="pipeline-row">
                  <div className="pipeline-meta">
                    <span>{stage.label}</span>
                    <strong>{stage.value}</strong>
                  </div>
                  <div className="pipeline-track">
                    <span
                      className={`pipeline-fill ${stage.tone}`}
                      style={{ width: `${Math.max(8, Math.round((stage.value / adminPipelinePeak) * 100))}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>

            <h4 className="dashboard-subhead">7-Day Approval Trend</h4>
            <div className="dashboard-trend">
              {adminTrend.map((day) => (
                <div key={day.key} className="trend-day">
                  <div className="trend-bars">
                    <span
                      className="trend-bar trend-incoming"
                      title={`${day.label} Incoming: ${day.incoming}`}
                      style={{ height: `${Math.max(4, Math.round((day.incoming / adminTrendPeak) * 76))}px` }}
                    />
                    <span
                      className="trend-bar trend-approved"
                      title={`${day.label} Approved: ${day.approved}`}
                      style={{ height: `${Math.max(4, Math.round((day.approved / adminTrendPeak) * 76))}px` }}
                    />
                    <span
                      className="trend-bar trend-rejected"
                      title={`${day.label} Rejected: ${day.rejected}`}
                      style={{ height: `${Math.max(4, Math.round((day.rejected / adminTrendPeak) * 76))}px` }}
                    />
                  </div>
                  <span className="trend-label">{day.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="dashboard-section-head">
              <h3>Activity Heatmap</h3>
              <span className="dashboard-section-chip">Ops Intensity</span>
            </div>
            <p className="caption">
              Weekly activity map for request traffic and approval decisions by time block.
            </p>

            <div className="heatmap-head">
              <span />
              {HEATMAP_BLOCKS.map((block) => (
                <span key={block} className="heatmap-block-label">{block}</span>
              ))}
            </div>

            <div className="heatmap-grid">
              {WEEKDAY_LABELS.map((day, dayIndex) => (
                <div key={day} className="heatmap-row">
                  <span className="heatmap-day">{day}</span>
                  {HEATMAP_BLOCKS.map((block, blockIndex) => {
                    const count = heatmap[dayIndex][blockIndex];
                    const level = count === 0 ? 0 : Math.min(4, Math.ceil((count / heatmapPeak) * 4));
                    return (
                      <span
                        key={`${day}-${block}`}
                        className={`heatmap-cell level-${level}`}
                        title={`${day} ${block}: ${count}`}
                      />
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="heatmap-legend">
              <span>Low</span>
              <div className="heatmap-legend-cells">
                <span className="heatmap-cell level-1" />
                <span className="heatmap-cell level-2" />
                <span className="heatmap-cell level-3" />
                <span className="heatmap-cell level-4" />
              </div>
              <span>High</span>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h3>Recent Notifications</h3>
        <p className="caption">
          {isGlobalAdmin
            ? 'Recent admin-facing activity from your selected scope.'
            : 'Latest updates for your project site.'}
        </p>
        {notifications.length === 0 ? (
          <p className="dashboard-empty">No notifications available yet.</p>
        ) : (
          <div className="dashboard-list">
            {notifications.slice(0, 6).map((notif) => (
              <div key={notif.id} className="dashboard-list-item">
                <div>
                  <strong>{notif.title}</strong>
                  <p>{notif.message}</p>
                </div>
                <span className="dashboard-list-meta">
                  {notif.created_at ? formatDate(notif.created_at) : '—'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
