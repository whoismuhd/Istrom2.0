import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../contexts/useAuth';
import AuthShell from '../components/AuthShell';
import PasswordInput from '../components/PasswordInput';
import ErrorMessage from '../components/ErrorMessage';
import LoadError from '../components/LoadError';
import { ADMIN_USERNAME } from '../utils/accounts';

export default function AccountSetup() {
  const { setupAdmin, user, loading, sessionError, retrySession } = useAuth();
  const [form, setForm] = useState({ access_code: '', password: '' });
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const status = useQuery({ queryKey: ['accountSetup'], queryFn: api.auth.setupStatus, retry: false });
  const update = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  if (loading || status.isLoading) return <div className="card" role="status">Loading...</div>;
  if (sessionError) return <LoadError error={sessionError} onRetry={retrySession} />;
  if (user && !user.needs_account_setup) return <Navigate to="/" replace />;
  if (!status.data?.setup_required && !status.error) return <Navigate to="/login/admin" replace />;

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    if (form.password !== confirmation) { setError(new Error('The passwords do not match.')); return; }
    setPending(true);
    try { await setupAdmin(form); }
    catch (err) { setError(err); }
    finally { setPending(false); }
  };

  return <AuthShell title="Set up your admin account" description="Enter your existing admin code to create your account.">
    {status.error ? <LoadError error={status.error} onRetry={status.refetch} /> : <form className="login-form" onSubmit={submit}>
      <PasswordInput id="setup-code" label="Existing admin code" value={form.access_code} onChange={update('access_code')} autoComplete="off" required />
      <input type="hidden" name="username" autoComplete="username" value={ADMIN_USERNAME} />
      <PasswordInput id="setup-password" label="Password" value={form.password} onChange={update('password')} autoComplete="new-password" minLength={8} maxLength={128} required />
      <PasswordInput id="setup-confirm" label="Confirm password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="new-password" minLength={8} maxLength={128} required />
      <p className="form-hint">At least 8 characters.</p>
      <ErrorMessage error={error} />
      <button className="btn btn-primary btn-block" disabled={pending}>{pending ? 'Creating account…' : 'Create admin account'}</button>
    </form>}
    {!user && <p className="login-help"><Link to="/login/admin">Back to admin sign in</Link></p>}
  </AuthShell>;
}
