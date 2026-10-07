import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatDate } from '../api';
import { useAuth } from '../contexts/useAuth';
import LoadError from '../components/LoadError';
import ErrorMessage from '../components/ErrorMessage';
import Modal from '../components/Modal';
import PasswordInput from '../components/PasswordInput';
import './Users.css';

const blank = { username: '', user_type: 'project_site', project_site: '', password: '', is_active: true };
const roleLabel = (role) => role === 'admin' ? 'Admin' : 'Site user';

export default function Users() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [siteFilter, setSiteFilter] = useState('');
  const [dialog, setDialog] = useState(null);
  const [form, setForm] = useState(blank);
  const [notice, setNotice] = useState('');
  const users = useQuery({ queryKey: ['users'], queryFn: api.users.list });
  const sites = useQuery({ queryKey: ['projectSites'], queryFn: api.projectSites.list });
  const mutation = useMutation({
    mutationFn: () => {
      if (dialog.mode === 'reset') return api.users.resetPassword(dialog.account.id, form.password);
      const data = { user_type: form.user_type, project_site: form.user_type === 'admin' ? null : form.project_site };
      return dialog.mode === 'create'
        ? api.users.create({ ...data, username: form.username, password: form.password })
        : api.users.update(dialog.account.id, { ...data, is_active: form.is_active });
    },
    onSuccess: () => {
      setNotice(dialog.mode === 'create' ? 'User created. Password change required at first sign-in.' : dialog.mode === 'reset' ? 'Password reset. Change required at next sign-in.' : 'User updated.');
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setDialog(null); setForm(blank);
    },
  });
  const open = (mode, account = null) => {
    mutation.reset(); setNotice('');
    setForm(account ? { ...blank, username: account.username, user_type: account.user_type, project_site: account.project_site || '', is_active: account.is_active } : blank);
    setDialog({ mode, account });
  };
  const close = () => { if (!mutation.isPending) { setDialog(null); setForm(blank); } };
  const update = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  if (users.error || sites.error) return <LoadError error={users.error || sites.error} onRetry={() => { users.refetch(); sites.refetch(); }} />;
  if (users.isLoading || sites.isLoading) return <div className="card" role="status">Loading users...</div>;
  const filtered = users.data.filter((account) => (!siteFilter || account.project_site === siteFilter) && account.username.toLowerCase().includes(search.toLowerCase()));
  const self = dialog?.account?.id === user.user_id;
  const invalidAssignment = form.user_type === 'project_site' && dialog?.mode !== 'reset'
    && (dialog?.mode === 'create' || form.is_active) && !sites.data.some((site) => site.name === form.project_site);
  return <div className="users-page">
    <div className="users-heading"><h1>Users</h1><button className="btn btn-primary" onClick={() => open('create')}>Add user</button></div>
    {notice && <div className="users-success" role="status">{notice}</div>}
    <section className="card users-directory" aria-label="User directory">
      <div className="users-toolbar"><div className="form-group"><label htmlFor="user-search">Find a user</label><input id="user-search" type="search" placeholder="Username" value={search} onChange={(e) => setSearch(e.target.value)} /></div><div className="form-group"><label htmlFor="user-site-filter">Project site</label><select id="user-site-filter" value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}><option value="">All sites and admins</option>{sites.data.map((site) => <option key={site.id} value={site.name}>{site.name}</option>)}</select></div><span className="users-total">{filtered.length} {filtered.length === 1 ? 'user' : 'users'}</span></div>
      {filtered.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Username</th><th>Role</th><th>Project site</th><th>Status</th><th>Last sign-in</th><th>Actions</th></tr></thead><tbody>{filtered.map((account) => <tr key={account.id}>
        <td><strong>{account.username}</strong>{account.id === user.user_id && <span className="users-you">You</span>}</td>
        <td>{roleLabel(account.user_type)}</td><td>{account.user_type === 'admin' ? 'All sites' : account.project_site}</td>
        <td><span className={`users-status ${account.is_active ? 'active' : 'disabled'}`}>{account.is_active ? 'Active' : 'Disabled'}</span>{account.user_type === 'project_site' && !sites.data.some((site) => site.name === account.project_site) && <span className="users-username">Project site inactive</span>}{account.is_active && account.must_change_password && <span className="users-username">Password change required</span>}</td>
        <td>{account.last_login_at ? formatDate(account.last_login_at) : 'Never signed in'}</td>
        <td><div className="users-actions"><button className="btn btn-secondary btn-sm" onClick={() => open('edit', account)} aria-label={`Edit ${account.username}`}>Edit</button>{account.id === user.user_id ? <Link className="btn btn-secondary btn-sm" to="/change-password">Change password</Link> : <button className="btn btn-secondary btn-sm" onClick={() => open('reset', account)} aria-label={`Reset password for ${account.username}`}>Reset password</button>}</div></td>
      </tr>)}</tbody></table></div> : <div className="users-empty"><h2>{search || siteFilter ? 'No matching users' : 'No users yet'}</h2><p>{search || siteFilter ? 'Try another username or project site.' : 'Add a user and assign a project site.'}</p></div>}
    </section>
    {dialog && <Modal onClose={close} labelledBy="user-dialog-title"><h2 id="user-dialog-title">{dialog.mode === 'create' ? 'Add site user' : dialog.mode === 'reset' ? 'Reset password' : 'Edit user'}</h2>
      <form className="user-form" onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }}>
        {dialog.mode === 'reset' ? <p>Temporary password for <strong>{dialog.account.username}</strong>. They must change it at next sign-in.</p> : <>
          <div className="form-group"><label htmlFor="user-username">Username</label><input id="user-username" value={form.username} onChange={update('username')} autoComplete="off" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={80} required disabled={dialog.mode === 'edit' || mutation.isPending} /></div>
          {form.user_type === 'project_site' && <div className="form-group"><label htmlFor="user-project">Assigned project site</label><select id="user-project" value={form.project_site} onChange={update('project_site')} disabled={mutation.isPending} required><option value="">Select a project site</option>{form.project_site && !sites.data.some((site) => site.name === form.project_site) && <option value={form.project_site}>{form.project_site} (inactive)</option>}{sites.data.map((site) => <option key={site.id} value={site.name}>{site.name}</option>)}</select>{!sites.data.length && <p className="form-hint">Create a project site in <Link to="/settings">Settings</Link> first.</p>}{form.project_site && !sites.data.some((site) => site.name === form.project_site) && <p className="form-hint">This site is inactive. Assign an active site to restore access.</p>}</div>}
          {dialog.mode === 'edit' && <div className="form-group"><label htmlFor="user-status">Account status</label><select id="user-status" value={form.is_active ? 'active' : 'disabled'} disabled={self || mutation.isPending} onChange={(e) => setForm({ ...form, is_active: e.target.value === 'active' })}><option value="active">Active</option><option value="disabled">Disabled</option></select><p className="form-hint">Disabling access keeps the person's request history.</p></div>}
        </>}
        {dialog.mode !== 'edit' && <><PasswordInput id="user-temporary-password" label="Temporary password" value={form.password} onChange={update('password')} disabled={mutation.isPending} autoComplete="new-password" minLength={8} maxLength={128} required /><p className="form-hint">At least 8 characters. This password cannot be viewed after saving.</p></>}
        <ErrorMessage error={mutation.error} />
        <div className="users-dialog-actions"><button type="button" className="btn btn-secondary" onClick={close} disabled={mutation.isPending}>Cancel</button><button type="submit" className="btn btn-primary" disabled={mutation.isPending || invalidAssignment}>{mutation.isPending ? 'Saving…' : dialog.mode === 'create' ? 'Create user' : dialog.mode === 'reset' ? 'Reset password' : 'Save changes'}</button></div>
      </form>
    </Modal>}
  </div>;
}
