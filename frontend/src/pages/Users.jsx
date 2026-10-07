import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatDate } from '../api';
import { useAuth } from '../contexts/useAuth';
import usePersistentState from '../hooks/usePersistentState';
import { USER_DRAFT, isUserDraft, userDraftFor, userDraftChanged, userExpectedState, adminDraftReview, isAdminDraftReviewCurrent } from '../utils/adminDrafts';
import LoadError from '../components/LoadError';
import ErrorMessage from '../components/ErrorMessage';
import Modal from '../components/Modal';
import PasswordInput from '../components/PasswordInput';
import './Users.css';

const accountScope = { scope: 'account' };
const roleLabel = (role) => role === 'admin' ? 'Admin' : 'Site user';

export default function Users() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [view, setView, , viewStorageError] = usePersistentState('users-view', { search: '', siteFilter: '' }, accountScope);
  const [draft, setDraft, clearDraft, draftStorageError] = usePersistentState('users-draft', USER_DRAFT, { ...accountScope, validate: isUserDraft });
  // Credentials stay in memory, outside the saved draft.
  const [password, setPassword] = useState('');
  const [reviewedChange, setReviewedChange] = useState(null);
  const [notice, setNotice] = useState('');
  const users = useQuery({ queryKey: ['users'], queryFn: api.users.list, staleTime: 0, refetchOnMount: 'always' });
  const sites = useQuery({ queryKey: ['projectSites'], queryFn: api.projectSites.list, staleTime: 0, refetchOnMount: 'always' });
  const freshRecords = users.isFetchedAfterMount && sites.isFetchedAfterMount && !users.isFetching && !sites.isFetching;
  const account = users.data?.find((candidate) => candidate.id === draft.accountId);
  const dialog = draft.mode === 'create' ? { mode: 'create', account: null }
    : account && ['edit', 'reset'].includes(draft.mode) ? { mode: draft.mode, account } : null;
  const changedAccount = userDraftChanged(draft, account);
  const needsReview = changedAccount && !isAdminDraftReviewCurrent('user', draft, account, reviewedChange);
  const form = {
    ...draft,
    username: account?.username || draft.username,
    user_type: account?.user_type || draft.user_type,
    password,
    is_active: draft.activeChoice ?? account?.is_active ?? true,
  };
  const mutation = useMutation({
    mutationFn: ({ mode, accountId, data, expected }) => {
      if (mode === 'reset') return api.users.resetPassword(accountId, data.password);
      const assignment = { user_type: data.user_type, project_site: data.user_type === 'admin' ? null : data.project_site };
      return mode === 'create'
        ? api.users.create({ ...assignment, username: data.username, password: data.password })
        : api.users.update(accountId, { ...assignment, is_active: data.is_active, expected });
    },
    onSuccess: (_, submitted) => {
      setNotice(submitted.mode === 'create' ? 'User created. Password change required at first sign-in.' : submitted.mode === 'reset' ? 'Password reset. Change required at next sign-in.' : 'User updated.');
      queryClient.invalidateQueries({ queryKey: ['users'] });
      if (submitted.clearDraft()) { setPassword(''); setReviewedChange(null); }
    },
    onError: (error) => { if (error.status === 409) { setReviewedChange(null); users.refetch(); sites.refetch(); } },
  });
  const open = (mode, account = null) => {
    mutation.reset(); setNotice('');
    setPassword(''); setReviewedChange(null);
    setDraft(userDraftFor(mode, account));
  };
  const close = () => { if (!mutation.isPending) { clearDraft(); setPassword(''); setReviewedChange(null); mutation.reset(); } };
  const update = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.value }));
  if (users.error || sites.error) return <LoadError error={users.error || sites.error} onRetry={() => { users.refetch(); sites.refetch(); }} />;
  if (users.isLoading || sites.isLoading) return <div className="card" role="status">Loading users...</div>;
  const { search, siteFilter } = view;
  const filtered = users.data.filter((account) => (!siteFilter || account.project_site === siteFilter) && account.username.toLowerCase().includes(search.toLowerCase()));
  const missingDraftAccount = ['edit', 'reset'].includes(draft.mode) && !account;
  const self = dialog?.account?.id === user.user_id;
  const invalidAssignment = form.user_type === 'project_site' && dialog?.mode !== 'reset'
    && (dialog?.mode === 'create' || form.is_active) && !sites.data.some((site) => site.name === form.project_site);
  return <div className="users-page">
    <div className="users-heading"><h1>Users</h1><button className="btn btn-primary" disabled={mutation.isPending} onClick={() => open('create')}>Add user</button></div>
    {(viewStorageError || draftStorageError) && <div className="alert alert-warning" role="status">Drafts could not be saved in this tab. Keep this page open until you save.</div>}
    {missingDraftAccount && <div className="alert alert-warning" role="status">The user in this draft is no longer available. <button type="button" className="btn btn-secondary btn-sm" onClick={close}>Discard draft</button></div>}
    {notice && <div className="users-success" role="status">{notice}</div>}
    <section className="card users-directory" aria-label="User directory">
      <div className="users-toolbar"><div className="form-group"><label htmlFor="user-search">Find a user</label><input id="user-search" type="search" placeholder="Username" value={search} onChange={(e) => setView((current) => ({ ...current, search: e.target.value }))} /></div><div className="form-group"><label htmlFor="user-site-filter">Project site</label><select id="user-site-filter" value={siteFilter} onChange={(e) => setView((current) => ({ ...current, siteFilter: e.target.value }))}><option value="">All sites and admins</option>{siteFilter && !sites.data.some((site) => site.name === siteFilter) && <option value={siteFilter}>{siteFilter} (inactive)</option>}{sites.data.map((site) => <option key={site.id} value={site.name}>{site.name}</option>)}</select></div><span className="users-total">{filtered.length} {filtered.length === 1 ? 'user' : 'users'}</span></div>
      {filtered.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Username</th><th>Role</th><th>Project site</th><th>Status</th><th>Last sign-in</th><th>Actions</th></tr></thead><tbody>{filtered.map((account) => <tr key={account.id}>
        <td><strong>{account.username}</strong>{account.id === user.user_id && <span className="users-you">You</span>}</td>
        <td>{roleLabel(account.user_type)}</td><td>{account.user_type === 'admin' ? 'All sites' : account.project_site}</td>
        <td><span className={`users-status ${account.is_active ? 'active' : 'disabled'}`}>{account.is_active ? 'Active' : 'Disabled'}</span>{account.user_type === 'project_site' && !sites.data.some((site) => site.name === account.project_site) && <span className="users-username">Project site inactive</span>}{account.is_active && account.must_change_password && <span className="users-username">Password change required</span>}</td>
        <td>{account.last_login_at ? formatDate(account.last_login_at) : 'Never signed in'}</td>
        <td><div className="users-actions"><button className="btn btn-secondary btn-sm" disabled={mutation.isPending} onClick={() => open('edit', account)} aria-label={`Edit ${account.username}`}>Edit</button>{account.id === user.user_id ? <Link className="btn btn-secondary btn-sm" to="/change-password">Change password</Link> : <button className="btn btn-secondary btn-sm" disabled={mutation.isPending} onClick={() => open('reset', account)} aria-label={`Reset password for ${account.username}`}>Reset password</button>}</div></td>
      </tr>)}</tbody></table></div> : <div className="users-empty"><h2>{search || siteFilter ? 'No matching users' : 'No users yet'}</h2><p>{search || siteFilter ? 'Try another username or project site.' : 'Add a user and assign a project site.'}</p></div>}
    </section>
    {dialog && <Modal onClose={close} labelledBy="user-dialog-title"><h2 id="user-dialog-title">{dialog.mode === 'create' ? 'Add site user' : dialog.mode === 'reset' ? 'Reset password' : 'Edit user'}</h2>
      <form className="user-form" onSubmit={(e) => { e.preventDefault(); if (!needsReview && freshRecords) mutation.mutate({ mode: dialog.mode, accountId: account?.id || 0, data: form, expected: dialog.mode === 'edit' ? userExpectedState(account) : undefined, clearDraft }); }}>
        {changedAccount && <div className="alert alert-warning" role="status"><p>This user changed since the draft was started. Current assignment: <strong>{account.user_type === 'admin' ? 'All sites' : account.project_site || 'Unassigned'}</strong>; status: <strong>{account.is_active ? 'Active' : 'Disabled'}</strong>.</p><label><input type="checkbox" checked={!needsReview} disabled={mutation.isPending || !freshRecords} onChange={(event) => setReviewedChange(event.target.checked ? adminDraftReview('user', draft, account) : null)} /> I reviewed the current account before applying this draft.</label></div>}
        {dialog.mode === 'reset' ? <p>Temporary password for <strong>{dialog.account.username}</strong>. They must change it at next sign-in.</p> : <>
          <div className="form-group"><label htmlFor="user-username">Username</label><input id="user-username" value={form.username} onChange={update('username')} autoComplete="off" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={80} required disabled={dialog.mode === 'edit' || mutation.isPending} /></div>
          {form.user_type === 'project_site' && <div className="form-group"><label htmlFor="user-project">Assigned project site</label><select id="user-project" value={form.project_site} onChange={update('project_site')} disabled={mutation.isPending} required><option value="">Select a project site</option>{form.project_site && !sites.data.some((site) => site.name === form.project_site) && <option value={form.project_site}>{form.project_site} (inactive)</option>}{sites.data.map((site) => <option key={site.id} value={site.name}>{site.name}</option>)}</select>{!sites.data.length && <p className="form-hint">Create a project site in <Link to="/settings">Settings</Link> first.</p>}{form.project_site && !sites.data.some((site) => site.name === form.project_site) && <p className="form-hint">This site is inactive. Assign an active site to restore access.</p>}</div>}
          {dialog.mode === 'edit' && <div className="form-group"><label htmlFor="user-status">Account status</label><select id="user-status" value={form.is_active ? 'active' : 'disabled'} disabled={self || mutation.isPending} onChange={(event) => setDraft((current) => ({ ...current, activeChoice: event.target.value === 'active' }))}><option value="active">Active</option><option value="disabled">Disabled</option></select><p className="form-hint">Disabling access keeps the person's request history.</p></div>}
        </>}
        {dialog.mode !== 'edit' && <><PasswordInput id="user-temporary-password" label="Temporary password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={mutation.isPending} autoComplete="new-password" minLength={8} maxLength={128} required /><p className="form-hint">At least 8 characters. This password cannot be viewed after saving.</p></>}
        <ErrorMessage error={mutation.error} />
        <div className="users-dialog-actions"><button type="button" className="btn btn-secondary" onClick={close} disabled={mutation.isPending}>Cancel</button><button type="submit" className="btn btn-primary" disabled={mutation.isPending || invalidAssignment || needsReview || !freshRecords}>{mutation.isPending ? 'Saving…' : dialog.mode === 'create' ? 'Create user' : dialog.mode === 'reset' ? 'Reset password' : 'Save changes'}</button></div>
      </form>
    </Modal>}
  </div>;
}
