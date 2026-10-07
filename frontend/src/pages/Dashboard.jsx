import { formatQuantity } from '../utils/inventory.js';
import { plannedTotal } from '../utils/budgets.js';
import { isSameDay, buildDailyTrend, requestActivity } from '../utils/activity.js';
import LoadError from '../components/LoadError';
import EmptyState from '../components/EmptyState';
import DashboardDateTime from '../components/DashboardDateTime';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import { api, formatDate, formatNaira } from '../api';
import './Dashboard.css';

export default function Dashboard() {
  const { isAdmin, isGlobalAdmin, getEffectiveProjectSite } = useAuth();
  const effectiveSite = getEffectiveProjectSite();
  const siteParams = effectiveSite ? { project_site: effectiveSite } : {};

  const { data: items = [], error: itemsError, isLoading: itemsLoading, refetch: retryItems } = useQuery({
    queryKey: ['dashboard', 'items', siteParams],
    queryFn: () => api.items.list(siteParams),
  });

  const { data: requests = [], error: requestsError, isLoading: requestsLoading, refetch: retryRequests } = useQuery({
    queryKey: ['dashboard', 'requests', siteParams],
    queryFn: () => api.requests.list(siteParams),
  });

  const { data: notifications = [], error: notificationsError, isLoading: notificationsLoading, refetch: retryNotifications } = useQuery({
    queryKey: ['dashboard', 'notifications', siteParams],
    queryFn: () => api.notifications.list(siteParams),
  });

  const { data: sites = [], error: sitesError, isLoading: sitesLoading, refetch: retrySites } = useQuery({
    queryKey: ['dashboard', 'projectSites'],
    queryFn: () => api.projectSites.list(),
    enabled: isGlobalAdmin,
  });

  const loadError = itemsError || requestsError || notificationsError || sitesError;
  if (loadError) return <LoadError error={loadError} onRetry={() => { retryItems(); retryRequests(); retryNotifications(); retrySites(); }} />;
  if (itemsLoading || requestsLoading || notificationsLoading || sitesLoading) return <div className="card" role="status">Loading...</div>;

  const originalValue = plannedTotal(items);
  const pending = requests.filter((r) => r.status === 'Pending');
  const approved = requests.filter((r) => r.status === 'Approved');
  const rejected = requests.filter((r) => r.status === 'Rejected');
  const inventoryGroups = Object.values(items.reduce((groups, item) => {
    const name = item.building_type || 'Unassigned building';
    groups[name] ||= { name, count: 0, items: [] };
    groups[name].count += 1;
    groups[name].items.push(item);
    return groups;
  }, {})).map((group) => ({...group, value:plannedTotal(group.items)})).sort((a, b) => b.value - a.value);
  const approvedToday = approved.filter((r) => isSameDay(r.updated_at)).length;
  const submittedToday = requests.filter((r) => isSameDay(r.created_at)).length;
  const trend = buildDailyTrend(requestActivity(requests), 7);
  const trendPeak = Math.max(1, ...trend.flatMap((day) => [day.incoming, day.approved, day.rejected]));
  const hasActivity = trend.some((day) => day.total > 0);
  const quickLinks = [
    { to: '/inventory', title: 'Inventory', detail: 'Original quantities and costs' },
    { to: '/budget-summary', title: 'Budget summary', detail: 'Planned costs by building and budget' },
    { to: '/actuals', title: 'Actuals', detail: 'Usage, remaining quantities, and actual costs' },
    ...(isGlobalAdmin ? [
      { to: '/users', title: 'Users', detail: 'Site accounts and project assignments' },
      { to: '/settings', title: 'Project settings', detail: 'Sites and activity logs' },
    ] : [{ to: '/notifications', title: 'Notifications', detail: 'Request updates for your site' }]),
  ];

  return <div className="dashboard-page">
    <div className="page-heading">
      <div><DashboardDateTime /><h1>{isAdmin ? 'Admin dashboard' : 'Site dashboard'}</h1></div>
      <div className="page-heading-actions">
        {isAdmin && <Link className="btn btn-secondary" to="/bulk-upload">Import workbook</Link>}
        <Link className="btn btn-primary" to={isAdmin ? '/review' : '/request'}>{isAdmin ? 'Review requests' : 'New request'}</Link>
      </div>
    </div>

    <div className="dashboard-kpi-grid">
      <div className="dashboard-kpi"><span className="dashboard-kpi-label">Original inventory value</span><strong className="dashboard-kpi-value">{formatNaira(originalValue)}</strong><span className="dashboard-kpi-note">{items.length} inventory items{isGlobalAdmin && !effectiveSite ? ` across ${sites.length} active ${sites.length === 1 ? 'site' : 'sites'}` : ''}</span></div>
      <div className="dashboard-kpi"><span className="dashboard-kpi-label">Pending requests</span><strong className="dashboard-kpi-value">{pending.length}</strong></div>
      <div className="dashboard-kpi"><span className="dashboard-kpi-label">Inventory items</span><strong className="dashboard-kpi-value">{items.length}</strong></div>
      <div className="dashboard-kpi"><span className="dashboard-kpi-label">{isAdmin ? 'Approved today' : 'Submitted today'}</span><strong className="dashboard-kpi-value">{isAdmin ? approvedToday : submittedToday}</strong></div>
    </div>

    <div className="dashboard-grid">
      <section className="card">
        <div className="dashboard-section-head"><h2>{isAdmin ? 'Awaiting approval' : 'Pending site requests'}</h2><Link className="text-link" to="/review">View all <span aria-hidden="true">→</span></Link></div>
        {pending.length === 0 ? <EmptyState title="No pending requests" /> : <div className="dashboard-request-list">
          {pending.slice(0, 5).map((req) => <Link to="/review" key={req.id} className="dashboard-request-row">
            <div><strong>{req.item_name || `Item #${req.item_id}`}</strong><span>{req.requested_by} · {formatDate(req.created_at, false)}</span></div>
            <div className="dashboard-request-qty"><div><strong>{formatQuantity(req.qty)} {req.item_unit}</strong>{req.shortage_qty > 0 && <small className="shortage-label">Shortfall: {formatQuantity(req.shortage_qty)}</small>}</div><span className="badge badge-pending">Pending</span></div>
          </Link>)}
        </div>}
      </section>
      <section className="card">
        <div className="dashboard-section-head"><h2>Original inventory</h2><Link className="text-link" to="/inventory">Inventory <span aria-hidden="true">→</span></Link></div>
        {items.length === 0 ? <EmptyState title="No inventory yet" description={isAdmin ? 'Add items or import a workbook.' : 'No inventory has been added for this site.'}>
          {isAdmin && <Link className="btn btn-secondary" to="/manual-entry">Add items</Link>}
        </EmptyState> : <div className="dashboard-stock-list">{inventoryGroups.map((group) => <div key={group.name} className="dashboard-stock-row">
          <div><strong>{group.name}</strong><span>{group.count} {group.count === 1 ? 'item' : 'items'}</span></div>
          <strong>{formatNaira(group.value)}</strong>
        </div>)}</div>}
      </section>
    </div>

    <div className="dashboard-grid dashboard-grid-secondary">
      <section className="card">
        <div className="dashboard-section-head"><h2>Request activity</h2><span className="dashboard-period">Last 7 days</span></div>
        {!hasActivity ? <EmptyState title="No activity this week" /> : <>
          <div className="dashboard-trend">{trend.map((day) => <div key={day.key} className="trend-day" title={`${day.label}: ${day.incoming} submitted, ${day.approved} approved, ${day.rejected} rejected`} role="img" aria-label={`${day.label}: ${day.incoming} submitted, ${day.approved} approved, ${day.rejected} rejected`}>
            <div className="trend-bars" aria-hidden="true">
              <span className="trend-bar trend-incoming" style={{ height: `${day.incoming / trendPeak * 100}px` }} />
              <span className="trend-bar trend-approved" style={{ height: `${day.approved / trendPeak * 100}px` }} />
              <span className="trend-bar trend-rejected" style={{ height: `${day.rejected / trendPeak * 100}px` }} />
            </div><span className="trend-label">{day.label}</span><span className="trend-total">{day.incoming} submitted</span>
          </div>)}</div>
          <div className="dashboard-chart-legend"><span><i className="legend-incoming" />Submitted</span><span><i className="legend-approved" />Approved</span><span><i className="legend-rejected" />Rejected</span></div>
        </>}
        <div className="dashboard-status-totals"><span>All requests</span><span><strong>{approved.length}</strong> approved</span><span><strong>{rejected.length}</strong> rejected</span><span><strong>{pending.length}</strong> pending</span></div>
      </section>
      <section className="card">
        <h2>Workspace</h2>
        <div className="dashboard-actions">{quickLinks.map((link) => <Link key={link.to} to={link.to} className="dashboard-action-link"><div><strong>{link.title}</strong><span>{link.detail}</span></div><span className="action-arrow" aria-hidden="true">→</span></Link>)}</div>
      </section>
    </div>

    <section className="card">
      <div className="dashboard-section-head"><h2>Recent updates</h2><Link className="text-link" to="/notifications">All notifications <span aria-hidden="true">→</span></Link></div>
      {notifications.length === 0 ? <EmptyState title="No recent updates" /> : <div className="dashboard-update-list">{notifications.slice(0, 5).map((notif) => <div key={notif.id} className="dashboard-update-row"><div><strong>{notif.title}</strong><p>{notif.message}</p></div><time>{formatDate(notif.created_at)}</time></div>)}</div>}
    </section>
  </div>;
}
