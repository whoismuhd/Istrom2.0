import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import usePersistentState from '../hooks/usePersistentState';
import { PROJECT_EDIT_DRAFT, isProjectEditDraft, projectEditDraftFor, projectEditDraftChanged, projectExpectedState, adminDraftReview, isAdminDraftReviewCurrent } from '../utils/adminDrafts';
import { workspaceGeneration } from '../utils/workspaceState';
import { api, formatDate } from '../api';
import ErrorMessage from '../components/ErrorMessage';
import LoadError from '../components/LoadError';
import Modal from '../components/Modal';
import './AdminSettings.css';

const blankSite = { name: '', description: '' };
const accountScope = { scope: 'account' };
const validSiteDraft = (value) => value.name.length <= 255 && value.description.length <= 2000;

function Section({ title, children, open, onToggle }) {
  return <section className="admin-accordion-section"><button type="button" className="admin-accordion-header" aria-expanded={open} onClick={onToggle}><span aria-hidden="true" className="admin-accordion-chevron">{open ? '⌄' : '›'}</span>{title}</button>{open && <div className="admin-accordion-body">{children}</div>}</section>;
}

export default function AdminSettings() {
  const { setProjectSite } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm, clearForm, formStorageError] = usePersistentState('settings-site-draft', blankSite, { ...accountScope, validate: validSiteDraft });
  const [editDraft, setEditDraft, clearEditDraft, editStorageError] = usePersistentState('settings-site-edit', PROJECT_EDIT_DRAFT, { ...accountScope, validate: isProjectEditDraft });
  const [reviewedChange, setReviewedChange] = useState(null);
  const [notice, setNotice] = useState('');
  const [view, setView, , viewStorageError] = usePersistentState('settings-view', { role: '', days: 30, projectSitesOpen: true, activityOpen: false, notificationsOpen: false }, { ...accountScope, validate: (value) => ['', 'admin', 'project_site', 'unknown'].includes(value.role) && [7, 30, 90].includes(value.days) });
  const { role, days } = view;
  const toggleSection = (key) => () => setView((current) => ({ ...current, [key]: !current[key] }));
  const sites = useQuery({ queryKey: ['projectSites'], queryFn: api.projectSites.list, staleTime: 0, refetchOnMount: 'always' });
  const freshSites = sites.isFetchedAfterMount && !sites.isFetching;
  const users = useQuery({ queryKey: ['users'], queryFn: api.users.list });
  const logs = useQuery({ queryKey: ['accessLogs', role, days], queryFn: () => api.accessLogs.list({ role: role || undefined, days }) });
  const notifications = useQuery({ queryKey: ['notifications'], queryFn: () => api.notifications.list() });
  const editing = sites.data?.find((site) => site.id === editDraft.id);
  const changedSite = projectEditDraftChanged(editDraft, editing);
  const needsReview = changedSite && !isAdminDraftReviewCurrent('project', editDraft, editing, reviewedChange);
  const editForm = { name: editDraft.name, description: editDraft.description };
  const create = useMutation({ mutationFn: ({ data }) => api.projectSites.create(data), onSuccess: (_, submitted) => { queryClient.invalidateQueries({ queryKey: ['projectSites'] }); submitted.clearDraft(); setNotice('Project site created.'); } });
  const update = useMutation({ mutationFn: ({ id, data, expected }) => api.projectSites.update(id, { ...data, expected }), onSuccess: (site, submitted) => { if (workspaceGeneration() === submitted.generation) setProjectSite(site.name, submitted.originalName); queryClient.invalidateQueries(); if (submitted.clearDraft()) setReviewedChange(null); setNotice('Project site updated. Assigned users must sign in again if its name changed.'); }, onError: (error) => { if (error.status === 409) { setReviewedChange(null); sites.refetch(); } } });
  const closeEdit = () => { if (!update.isPending) { clearEditDraft(); setReviewedChange(null); update.reset(); } };
  const deactivate = useMutation({ mutationFn: ({ id }) => api.projectSites.delete(id), onSuccess: (_, submitted) => { if (workspaceGeneration() === submitted.generation) setProjectSite(null, submitted.originalName); queryClient.invalidateQueries(); setNotice('Project site deactivated. Records retained; site user access disabled.'); } });
  const clearLogs = useMutation({ mutationFn: api.accessLogs.clear, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['accessLogs'] }) });
  const clearNotifications = useMutation({ mutationFn: api.notifications.clearAll, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }) });
  const deleteNotification = useMutation({ mutationFn: api.notifications.delete, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }) });
  const queries = [sites, users, logs, notifications];
  const failed = queries.find((query) => query.error);
  if (failed) return <LoadError error={failed.error} onRetry={() => queries.forEach((query) => query.refetch())} />;
  if (queries.some((query) => query.isLoading)) return <div className="card" role="status">Loading settings...</div>;
  return <div className="admin-settings">
    <h1 className="admin-settings-title">Settings</h1>
    {(formStorageError || editStorageError || viewStorageError) && <div className="alert alert-warning" role="status">Drafts could not be saved in this tab. Keep this page open until you save.</div>}
    {editDraft.id > 0 && !editing && <div className="alert alert-warning" role="status">The project site in this draft is no longer active. <button type="button" className="btn btn-secondary btn-sm" onClick={closeEdit}>Discard draft</button></div>}
    <ErrorMessage error={create.error || update.error || deactivate.error || clearLogs.error || clearNotifications.error || deleteNotification.error} />
    {notice && <div className="settings-notice" role="status">{notice}</div>}
    <div className="admin-metrics-row"><div className="admin-metric-card"><span className="admin-metric-label">Active project sites</span><strong className="admin-metric-value">{sites.data.length}</strong></div><div className="admin-metric-card"><span className="admin-metric-label">Active users</span><strong className="admin-metric-value">{users.data.filter((account) => account.is_active).length}</strong></div></div>
    <div className="settings-access-card"><div><h2>Users and access</h2></div><Link to="/users" className="btn btn-secondary">Manage users</Link><Link to="/change-password" className="btn btn-secondary">Change my password</Link></div>
    <div className="admin-accordion">
      <Section title="Project sites" open={view.projectSitesOpen} onToggle={toggleSection('projectSitesOpen')}>
        <div className="project-sites-list">{sites.data.map((site) => <div key={site.id} className="project-site-card"><div className="project-site-info"><div className="project-site-title">{site.name}</div><p className="admin-notif-desc">{site.description && <>{site.description} · </>}{users.data.filter((account) => account.project_site === site.name && account.is_active).length} active site users</p></div><div className="project-site-actions"><button className="btn btn-secondary btn-sm" disabled={update.isPending} onClick={() => { update.reset(); setReviewedChange(null); setEditDraft(projectEditDraftFor(site)); }}>Edit</button><button className="btn btn-secondary btn-sm" onClick={() => { setProjectSite(site.name); navigate('/inventory'); }}>View inventory</button><button className="btn btn-danger btn-sm" disabled={deactivate.isPending} onClick={() => { if (confirm(`Deactivate ${site.name}? Assigned users will lose access. Project records will be kept.`)) deactivate.mutate({ id: site.id, originalName: site.name, generation: workspaceGeneration() }); }}>Deactivate</button></div></div>)}</div>
        <form className="add-project-site-section" onSubmit={(event) => { event.preventDefault(); create.mutate({ data: form, clearDraft: clearForm }); }}><h2 className="add-project-site-title">Add project site</h2><div className="form-group"><label htmlFor="site-name">Project site name</label><input id="site-name" disabled={create.isPending} value={form.name} onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))} placeholder="e.g. Downtown Plaza" maxLength={255} required /></div><div className="form-group"><label htmlFor="site-description">Description (optional)</label><textarea id="site-description" disabled={create.isPending} value={form.description} onChange={(e) => setForm((current) => ({ ...current, description: e.target.value }))} maxLength={2000} rows={3} /></div><button className="btn btn-primary" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create project site'}</button>{(form.name || form.description) && <button className="btn btn-secondary" type="button" disabled={create.isPending} onClick={() => { clearForm(); create.reset(); }}>Discard draft</button>}</form>
      </Section>
      <Section title="Sign-in activity" open={view.activityOpen} onToggle={toggleSection('activityOpen')}><div className="form-row"><div className="form-group"><label htmlFor="log-role">Role</label><select id="log-role" value={role} onChange={(e) => setView((current) => ({ ...current, role: e.target.value }))}><option value="">All roles</option><option value="admin">Admin</option><option value="project_site">Site user</option><option value="unknown">Unsuccessful attempts</option></select></div><div className="form-group"><label htmlFor="log-days">Period</label><select id="log-days" value={days} onChange={(e) => setView((current) => ({ ...current, days: Number(e.target.value) }))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select></div></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Username</th><th>Time</th><th>Result</th><th>Role</th></tr></thead><tbody>{logs.data.map((log) => <tr key={log.id}><td>{log.user_name || 'Unknown'}</td><td>{formatDate(log.access_time)}</td><td>{log.success ? 'Successful' : 'Failed'}</td><td>{log.role === 'project_site' ? 'Site user' : log.role}</td></tr>)}</tbody></table>{!logs.data.length && <p className="admin-notif-empty">No sign-in activity in this period.</p>}</div><button className="btn btn-danger btn-sm" disabled={!logs.data.length || clearLogs.isPending} onClick={() => { if (confirm('Permanently clear the sign-in log?')) clearLogs.mutate(); }}>Clear log</button></Section>
      <Section title="Notifications" open={view.notificationsOpen} onToggle={toggleSection('notificationsOpen')}><div className="admin-notifications-list">{notifications.data.slice(0, 20).map((notification) => <div className="admin-notif-item" key={notification.id}><div><strong className="admin-notif-title">{notification.title}</strong><p className="admin-notif-msg">{notification.message}</p><span className="admin-notif-time">{formatDate(notification.created_at)}</span></div><button className="btn btn-danger btn-sm" disabled={deleteNotification.isPending} onClick={() => { if (confirm('Delete this notification for all users?')) deleteNotification.mutate(notification.id); }}>Delete</button></div>)}{!notifications.data.length && <p className="admin-notif-empty">No notifications yet.</p>}</div><div className="admin-notif-footer-actions"><Link to="/notifications" className="btn btn-secondary">View all notifications</Link><button className="btn btn-danger" disabled={!notifications.data.length || clearNotifications.isPending} onClick={() => { if (confirm('Permanently clear all notifications?')) clearNotifications.mutate(); }}>Clear notifications</button></div></Section>
    </div>
    {editing && <Modal onClose={closeEdit} labelledBy="edit-site-title"><h2 id="edit-site-title">Edit project site</h2><form onSubmit={(event) => { event.preventDefault(); if (!needsReview && freshSites) update.mutate({ id: editing.id, originalName: editing.name, generation: workspaceGeneration(), data: editForm, expected: projectExpectedState(editing), clearDraft: clearEditDraft }); }}>{changedSite && <div className="alert alert-warning" role="status"><p>This project site changed since the draft was started. Current name: <strong>{editing.name}</strong>. Current description: <strong>{editing.description || 'None'}</strong>.</p><label><input type="checkbox" checked={!needsReview} disabled={update.isPending || !freshSites} onChange={(event) => setReviewedChange(event.target.checked ? adminDraftReview('project', editDraft, editing) : null)} /> I reviewed the current project site before applying this draft.</label></div>}<div className="form-group"><label htmlFor="edit-site-name">Name</label><input id="edit-site-name" disabled={update.isPending} value={editForm.name} onChange={(e) => setEditDraft((current) => ({ ...current, name: e.target.value }))} maxLength={255} required /></div><div className="form-group"><label htmlFor="edit-site-description">Description</label><textarea id="edit-site-description" disabled={update.isPending} value={editForm.description} onChange={(e) => setEditDraft((current) => ({ ...current, description: e.target.value }))} maxLength={2000} rows={3} /></div><ErrorMessage error={update.error} /><button className="btn btn-primary" disabled={update.isPending || needsReview || !freshSites}>Save changes</button><button className="btn btn-secondary" type="button" onClick={closeEdit} disabled={update.isPending}>Cancel</button></form></Modal>}
  </div>;
}
