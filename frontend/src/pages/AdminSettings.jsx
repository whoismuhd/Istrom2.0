import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import { api, formatDate } from '../api';
import ErrorMessage from '../components/ErrorMessage';
import LoadError from '../components/LoadError';
import Modal from '../components/Modal';
import './AdminSettings.css';

function Section({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return <section className="admin-accordion-section"><button type="button" className="admin-accordion-header" aria-expanded={open} onClick={() => setOpen(!open)}><span aria-hidden="true" className="admin-accordion-chevron">{open ? '⌄' : '›'}</span>{title}</button>{open && <div className="admin-accordion-body">{children}</div>}</section>;
}

export default function AdminSettings() {
  const { setProjectSite, projectSite } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', description: '' });
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', description: '' });
  const [notice, setNotice] = useState('');
  const [role, setRole] = useState('');
  const [days, setDays] = useState(30);
  const sites = useQuery({ queryKey: ['projectSites'], queryFn: api.projectSites.list });
  const users = useQuery({ queryKey: ['users'], queryFn: api.users.list });
  const logs = useQuery({ queryKey: ['accessLogs', role, days], queryFn: () => api.accessLogs.list({ role: role || undefined, days }) });
  const notifications = useQuery({ queryKey: ['notifications'], queryFn: () => api.notifications.list() });
  const create = useMutation({ mutationFn: api.projectSites.create, onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['projectSites'] }); setForm({ name: '', description: '' }); setNotice('Project site created.'); } });
  const update = useMutation({ mutationFn: () => api.projectSites.update(editing.id, editForm), onSuccess: (site) => { if (projectSite === editing.name) setProjectSite(site.name); queryClient.invalidateQueries(); setEditing(null); setNotice('Project site updated. Assigned users must sign in again if its name changed.'); } });
  const deactivate = useMutation({ mutationFn: api.projectSites.delete, onSuccess: (_, id) => { if (sites.data.find((site) => site.id === id)?.name === projectSite) setProjectSite(null); queryClient.invalidateQueries(); setNotice('Project site deactivated. Records retained; site user access disabled.'); } });
  const clearLogs = useMutation({ mutationFn: api.accessLogs.clear, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['accessLogs'] }) });
  const clearNotifications = useMutation({ mutationFn: api.notifications.clearAll, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }) });
  const deleteNotification = useMutation({ mutationFn: api.notifications.delete, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }) });
  const queries = [sites, users, logs, notifications];
  const failed = queries.find((query) => query.error);
  if (failed) return <LoadError error={failed.error} onRetry={() => queries.forEach((query) => query.refetch())} />;
  if (queries.some((query) => query.isLoading)) return <div className="card" role="status">Loading settings...</div>;
  return <div className="admin-settings">
    <h1 className="admin-settings-title">Settings</h1>
    <ErrorMessage error={create.error || update.error || deactivate.error || clearLogs.error || clearNotifications.error || deleteNotification.error} />
    {notice && <div className="settings-notice" role="status">{notice}</div>}
    <div className="admin-metrics-row"><div className="admin-metric-card"><span className="admin-metric-label">Active project sites</span><strong className="admin-metric-value">{sites.data.length}</strong></div><div className="admin-metric-card"><span className="admin-metric-label">Active users</span><strong className="admin-metric-value">{users.data.filter((account) => account.is_active).length}</strong></div></div>
    <div className="settings-access-card"><div><h2>Users and access</h2></div><Link to="/users" className="btn btn-secondary">Manage users</Link><Link to="/change-password" className="btn btn-secondary">Change my password</Link></div>
    <div className="admin-accordion">
      <Section title="Project sites" defaultOpen>
        <div className="project-sites-list">{sites.data.map((site) => <div key={site.id} className="project-site-card"><div className="project-site-info"><div className="project-site-title">{site.name}</div><p className="admin-notif-desc">{site.description && <>{site.description} · </>}{users.data.filter((account) => account.project_site === site.name && account.is_active).length} active site users</p></div><div className="project-site-actions"><button className="btn btn-secondary btn-sm" onClick={() => { update.reset(); setEditing(site); setEditForm({ name: site.name, description: site.description || '' }); }}>Edit</button><button className="btn btn-secondary btn-sm" onClick={() => { setProjectSite(site.name); navigate('/inventory'); }}>View inventory</button><button className="btn btn-danger btn-sm" disabled={deactivate.isPending} onClick={() => { if (confirm(`Deactivate ${site.name}? Assigned users will lose access. Project records will be kept.`)) deactivate.mutate(site.id); }}>Deactivate</button></div></div>)}</div>
        <form className="add-project-site-section" onSubmit={(event) => { event.preventDefault(); create.mutate(form); }}><h2 className="add-project-site-title">Add project site</h2><div className="form-group"><label htmlFor="site-name">Project site name</label><input id="site-name" disabled={create.isPending} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Downtown Plaza" maxLength={255} required /></div><div className="form-group"><label htmlFor="site-description">Description (optional)</label><textarea id="site-description" disabled={create.isPending} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={2000} rows={3} /></div><button className="btn btn-primary" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create project site'}</button></form>
      </Section>
      <Section title="Sign-in activity"><div className="form-row"><div className="form-group"><label htmlFor="log-role">Role</label><select id="log-role" value={role} onChange={(e) => setRole(e.target.value)}><option value="">All roles</option><option value="admin">Admin</option><option value="project_site">Site user</option><option value="unknown">Unsuccessful attempts</option></select></div><div className="form-group"><label htmlFor="log-days">Period</label><select id="log-days" value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select></div></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Username</th><th>Time</th><th>Result</th><th>Role</th></tr></thead><tbody>{logs.data.map((log) => <tr key={log.id}><td>{log.user_name || 'Unknown'}</td><td>{formatDate(log.access_time)}</td><td>{log.success ? 'Successful' : 'Failed'}</td><td>{log.role === 'project_site' ? 'Site user' : log.role}</td></tr>)}</tbody></table>{!logs.data.length && <p className="admin-notif-empty">No sign-in activity in this period.</p>}</div><button className="btn btn-danger btn-sm" disabled={!logs.data.length || clearLogs.isPending} onClick={() => { if (confirm('Permanently clear the sign-in log?')) clearLogs.mutate(); }}>Clear log</button></Section>
      <Section title="Notifications"><div className="admin-notifications-list">{notifications.data.slice(0, 20).map((notification) => <div className="admin-notif-item" key={notification.id}><div><strong className="admin-notif-title">{notification.title}</strong><p className="admin-notif-msg">{notification.message}</p><span className="admin-notif-time">{formatDate(notification.created_at)}</span></div><button className="btn btn-danger btn-sm" disabled={deleteNotification.isPending} onClick={() => { if (confirm('Delete this notification for all users?')) deleteNotification.mutate(notification.id); }}>Delete</button></div>)}{!notifications.data.length && <p className="admin-notif-empty">No notifications yet.</p>}</div><div className="admin-notif-footer-actions"><Link to="/notifications" className="btn btn-secondary">View all notifications</Link><button className="btn btn-danger" disabled={!notifications.data.length || clearNotifications.isPending} onClick={() => { if (confirm('Permanently clear all notifications?')) clearNotifications.mutate(); }}>Clear notifications</button></div></Section>
    </div>
    {editing && <Modal onClose={() => { if (!update.isPending) setEditing(null); }} labelledBy="edit-site-title"><h2 id="edit-site-title">Edit project site</h2><form onSubmit={(event) => { event.preventDefault(); update.mutate(); }}><div className="form-group"><label htmlFor="edit-site-name">Name</label><input id="edit-site-name" disabled={update.isPending} value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} maxLength={255} required /></div><div className="form-group"><label htmlFor="edit-site-description">Description</label><textarea id="edit-site-description" disabled={update.isPending} value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} maxLength={2000} rows={3} /></div><ErrorMessage error={update.error} /><button className="btn btn-primary" disabled={update.isPending}>Save changes</button><button className="btn btn-secondary" type="button" onClick={() => setEditing(null)} disabled={update.isPending}>Cancel</button></form></Modal>}
  </div>;
}
