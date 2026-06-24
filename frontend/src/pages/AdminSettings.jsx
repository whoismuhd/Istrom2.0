import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import { api, formatDate } from '../api';
import './AdminSettings.css';

function AccordionSection({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="admin-accordion-section">
      <button
        type="button"
        className="admin-accordion-header"
        onClick={() => setOpen(!open)}
      >
        <span className="admin-accordion-chevron">{open ? 'v' : '>'}</span>
        <span>{title}</span>
      </button>
      {open && <div className="admin-accordion-body">{children}</div>}
    </div>
  );
}

function MetricCard({ label, value }) {
  return (
    <div className="admin-metric-card">
      <div className="admin-metric-header">
        <span className="admin-metric-label">{label}</span>
      </div>
      <span className="admin-metric-value">{value}</span>
    </div>
  );
}

export default function AdminSettings() {
  const { isGlobalAdmin, setProjectSite } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [newAdminCode, setNewAdminCode] = useState('');
  const [newSiteName, setNewSiteName] = useState('');
  const [newSitePasscode, setNewSitePasscode] = useState('');
  const [newSiteDescription, setNewSiteDescription] = useState('');
  const [editingSite, setEditingSite] = useState(null);
  const [editSiteName, setEditSiteName] = useState('');
  const [siteUserCode, setSiteUserCode] = useState('');
  const [editSiteId, setEditSiteId] = useState(null);
  const [roleFilter, setRoleFilter] = useState('');
  const [daysFilter, setDaysFilter] = useState(30);
  const [showNewAdminCode, setShowNewAdminCode] = useState(false);
  const [showNewSitePasscode, setShowNewSitePasscode] = useState(false);
  const [showEditSiteCode, setShowEditSiteCode] = useState(false);

  const { data: accessCodes = {} } = useQuery({
    queryKey: ['accessCodes'],
    queryFn: () => api.accessCodes.get(),
    enabled: isGlobalAdmin,
  });

  const { data: sites = [] } = useQuery({
    queryKey: ['projectSites'],
    queryFn: () => api.projectSites.list(),
    enabled: isGlobalAdmin,
  });

  const { data: items = [] } = useQuery({
    queryKey: ['items'],
    queryFn: () => api.items.list(),
    enabled: isGlobalAdmin,
  });

  const { data: requests = [] } = useQuery({
    queryKey: ['requests'],
    queryFn: () => api.requests.list(),
    enabled: isGlobalAdmin,
  });

  const { data: logs = [] } = useQuery({
    queryKey: ['accessLogs', roleFilter, daysFilter],
    queryFn: () => api.accessLogs.list({ role: roleFilter || undefined, days: daysFilter }),
    enabled: isGlobalAdmin,
  });

  const { data: notifications = [] } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.notifications.list(),
    enabled: isGlobalAdmin,
  });

  const today = new Date().toISOString().split('T')[0];
  const todayLogins = logs.filter((l) =>
    l.access_time && l.access_time.startsWith(today)
  ).length;

  const updateAdminMutation = useMutation({
    mutationFn: (code) => api.accessCodes.update(code),
    onSuccess: () => {
      queryClient.invalidateQueries(['accessCodes']);
      setNewAdminCode('');
    },
  });

  const createSiteMutation = useMutation({
    mutationFn: (data) => api.projectSites.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries(['projectSites']);
      setNewSiteName('');
      setNewSitePasscode('');
      setNewSiteDescription('');
    },
  });

  const updateSiteMutation = useMutation({
    mutationFn: ({ id, data }) => api.projectSites.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries(['projectSites']);
      setEditingSite(null);
      setEditSiteId(null);
    },
  });

  const updateSiteCodeMutation = useMutation({
    mutationFn: ({ id, userCode }) => api.projectSites.updateAccessCode(id, userCode),
    onSuccess: () => {
      queryClient.invalidateQueries(['projectSites']);
      setEditSiteId(null);
      setSiteUserCode('');
    },
  });

  const deleteSiteMutation = useMutation({
    mutationFn: (id) => api.projectSites.delete(id),
    onSuccess: () => queryClient.invalidateQueries(['projectSites']),
  });

  const clearLogsMutation = useMutation({
    mutationFn: () => api.accessLogs.clear(),
    onSuccess: () => queryClient.invalidateQueries(['accessLogs']),
  });

  const deleteNotifMutation = useMutation({
    mutationFn: (id) => api.notifications.delete(id),
    onSuccess: () => queryClient.invalidateQueries(['notifications']),
  });

  const clearNotifsMutation = useMutation({
    mutationFn: () => api.notifications.clearAll(),
    onSuccess: () => queryClient.invalidateQueries(['notifications']),
  });

  if (!isGlobalAdmin) return <div className="card"><p>Global admin access required.</p></div>;

  return (
    <div className="admin-settings">
      <h1 className="admin-settings-title">System Administration</h1>
      <h2 className="admin-settings-subtitle">System Overview</h2>

      <div className="admin-metrics-row">
        <MetricCard label="Projects" value={sites.length} />
        <MetricCard label="Total Items" value={items.length} />
        <MetricCard label="Total Requests" value={requests.length} />
        <MetricCard label="Today's Logins" value={todayLogins} />
      </div>

      <div className="admin-accordion">
        <AccordionSection title="Access Code Management">
          <div className="access-code-current">
            Admin Code Status: {accessCodes.admin_code || 'Not Configured'}
          </div>
          <h4 className="access-code-change-title">Change Admin Access Code</h4>
          <p className="access-code-change-desc">
            Changing the admin access code will affect admin login. Inform your team of the new code.
          </p>
          <div className="form-group">
            <label>New Admin Code</label>
            <div className="password-input-wrap">
              <input
                type={showNewAdminCode ? 'text' : 'password'}
                value={newAdminCode}
                onChange={(e) => setNewAdminCode(e.target.value)}
                placeholder="Enter new admin code"
              />
              <button
                type="button"
                className="btn-toggle-password"
                onClick={() => setShowNewAdminCode(!showNewAdminCode)}
                title={showNewAdminCode ? 'Hide' : 'Show'}
                aria-label={showNewAdminCode ? 'Hide' : 'Show'}
              >
                {showNewAdminCode ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </div>
          <button className="btn btn-update-admin" onClick={() => updateAdminMutation.mutate(newAdminCode)} disabled={!newAdminCode}>
            Update Admin Code
          </button>
        </AccordionSection>

        <AccordionSection title="Project Site Management">
          <div className="project-sites-list">
            {sites.map((s, index) => (
                <div key={s.id} className="project-site-card">
                  <div className="project-site-info">
                    <div className="project-site-title">{index + 1}. {s.name} Project</div>
                  <div className="project-site-access-code">User Access Code: {s.user_code || 'Not Configured'}</div>
                  </div>
                <div className="project-site-actions">
                  <button className="btn btn-secondary btn-sm" onClick={() => { setEditingSite(s); setEditSiteName(s.name); }}>
                    Edit
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => { setEditSiteId(s.id); setSiteUserCode(''); }}>
                    Access Code
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => {
                      if (confirm(`Delete project site "${s.name}"? This will deactivate the site and users will no longer be able to access it.`)) {
                        deleteSiteMutation.mutate(s.id);
                      }
                    }}
                  >
                    Delete
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setProjectSite(s.name);
                      navigate('/inventory');
                    }}
                  >
                    View
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="add-project-site-section">
            <h4 className="add-project-site-title">
              Add New Project Site
            </h4>
            <div className="form-group">
              <label>Project Site Name:</label>
              <input
                value={newSiteName}
                onChange={(e) => setNewSiteName(e.target.value)}
                placeholder="e.g., Downtown Plaza"
              />
            </div>
            <div className="form-group">
              <label>Description (Optional):</label>
              <textarea
                value={newSiteDescription}
                onChange={(e) => setNewSiteDescription(e.target.value)}
                placeholder="Brief description of the project site"
                rows={3}
              />
            </div>
            <div className="form-group">
              <label>Project Site Passcode:</label>
              <div className="password-input-wrap">
                <input
                  type={showNewSitePasscode ? 'text' : 'password'}
                  value={newSitePasscode}
                  onChange={(e) => setNewSitePasscode(e.target.value)}
                  placeholder="Passcode for site access"
                />
                <button
                  type="button"
                  className="btn-toggle-password"
                  onClick={() => setShowNewSitePasscode(!showNewSitePasscode)}
                  title={showNewSitePasscode ? 'Hide' : 'Show'}
                  aria-label={showNewSitePasscode ? 'Hide' : 'Show'}
                >
                  {showNewSitePasscode ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
            <button
              className="btn btn-add-project-site"
              onClick={() => createSiteMutation.mutate({ name: newSiteName, user_code: newSitePasscode, description: newSiteDescription || undefined })}
              disabled={!newSiteName || !newSitePasscode}
            >
              Add Project Site
            </button>
          </div>

          {editingSite && (
            <div className="modal-overlay" onClick={() => setEditingSite(null)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h3>Edit Project Site</h3>
                <input value={editSiteName} onChange={(e) => setEditSiteName(e.target.value)} />
                <button className="btn btn-primary" onClick={() => updateSiteMutation.mutate({ id: editingSite.id, data: { name: editSiteName } })}>
                  Save
                </button>
                <button className="btn btn-secondary" onClick={() => setEditingSite(null)}>Cancel</button>
              </div>
            </div>
          )}

          {editSiteId && (
            <div className="modal-overlay" onClick={() => setEditSiteId(null)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h3>Set User Access Code</h3>
                <div className="form-group">
                  <label>New User Code</label>
                  <div className="password-input-wrap">
                    <input
                      type={showEditSiteCode ? 'text' : 'password'}
                      value={siteUserCode}
                      onChange={(e) => setSiteUserCode(e.target.value)}
                      placeholder="New user code"
                    />
                    <button
                      type="button"
                      className="btn-toggle-password"
                      onClick={() => setShowEditSiteCode(!showEditSiteCode)}
                      title={showEditSiteCode ? 'Hide' : 'Show'}
                      aria-label={showEditSiteCode ? 'Hide' : 'Show'}
                    >
                      {showEditSiteCode ? (
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                          <line x1="1" y1="1" x2="23" y2="23" />
                        </svg>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
                <button className="btn btn-primary" onClick={() => updateSiteCodeMutation.mutate({ id: editSiteId, userCode: siteUserCode })}>
                  Update
                </button>
                <button className="btn btn-secondary" onClick={() => setEditSiteId(null)}>Cancel</button>
              </div>
            </div>
          )}
        </AccordionSection>

        <AccordionSection title="Access Logs">
          <div className="form-row">
            <div className="form-group">
              <label>Role</label>
              <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
                <option value="">All</option>
                <option value="admin">Admin</option>
                <option value="project_site">Project Site</option>
                <option value="unknown">Unknown</option>
              </select>
            </div>
            <div className="form-group">
              <label>Last N Days</label>
              <select value={daysFilter} onChange={(e) => setDaysFilter(Number(e.target.value))}>
                <option value={7}>7</option>
                <option value={30}>30</option>
                <option value={90}>90</option>
              </select>
            </div>
          </div>
          <button className="btn btn-secondary" onClick={() => queryClient.invalidateQueries(['accessLogs'])}>
            Refresh
          </button>
          <button className="btn btn-danger" onClick={() => clearLogsMutation.mutate()}>
            Clear ALL Logs
          </button>

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Access Code</th>
                  <th>User Name</th>
                  <th>Time</th>
                  <th>Success</th>
                  <th>Role</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td>{l.access_code || '-'}</td>
                    <td>{l.user_name || '-'}</td>
                    <td>{l.access_time ? formatDate(l.access_time) : '-'}</td>
                    <td>{l.success ? 'Yes' : 'No'}</td>
                    <td>{l.role || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AccordionSection>

        <AccordionSection title="Notifications">
          <p className="admin-notif-desc">Recent notifications across all project sites (including New Request alerts for admins).</p>
          <div className="admin-notifications-list">
            {notifications.length === 0 ? (
              <p className="admin-notif-empty">No notifications yet.</p>
            ) : (
              notifications.slice(0, 20).map((n) => (
                <div key={n.id} className={`admin-notif-item ${n.is_read ? 'read' : ''}`}>
                  <div className="admin-notif-main">
                    <span className="admin-notif-type">{n.notification_type.replace(/_/g, ' ')}</span>
                    <span className="admin-notif-title">{n.title}</span>
                    <p className="admin-notif-msg">{n.message}</p>
                    {(n.budget || n.building_subtype) && (
                      <div className="admin-notif-details">
                        {n.budget && <span><strong>Budget:</strong> {n.budget}</span>}
                        {n.building_subtype && <span><strong>Building:</strong> {n.building_subtype}</span>}
                      </div>
                    )}
                  </div>
                  <div className="admin-notif-actions">
                    <span className="admin-notif-time">
                      {n.created_at ? formatDate(n.created_at) : ''}
                    </span>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => {
                        if (confirm('Delete this notification? It will be removed for all users.')) {
                          deleteNotifMutation.mutate(n.id);
                        }
                      }}
                      title="Delete notification"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="admin-notif-footer-actions">
            <button className="btn btn-secondary" onClick={() => navigate('/notifications')}>
              View All Notifications
            </button>
            {notifications.length > 0 && (
              <button
                className="btn btn-danger"
                onClick={() => {
                  if (confirm('Clear ALL notifications? This will remove them for all users (admin and project sites).')) {
                    clearNotifsMutation.mutate();
                  }
                }}
              >
                Clear All Notifications
              </button>
            )}
          </div>
        </AccordionSection>
      </div>
    </div>
  );
}
