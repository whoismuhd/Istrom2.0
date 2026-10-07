import { useEffect, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/useAuth';
import AuthShell from '../components/AuthShell';
import PasswordInput from '../components/PasswordInput';
import ErrorMessage from '../components/ErrorMessage';
import LoadError from '../components/LoadError';

export default function ChangePassword() {
  const { user, loading, changePassword, logout, sessionError, retrySession } = useAuth();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const active = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  if (loading) return <div className="card" role="status">Loading...</div>;
  if (sessionError) return <LoadError error={sessionError} onRetry={retrySession} />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.needs_account_setup) return <Navigate to="/account-setup" replace />;
  if (done) return <Navigate to="/dashboard" replace />;
  const submit = async (event) => {
    event.preventDefault(); setError(null);
    if (password !== confirmation) { setError(new Error('The passwords do not match.')); return; }
    setPending(true);
    try { await changePassword({ current_password: current, new_password: password }); if (active.current) setDone(true); }
    catch (err) { if (active.current && err.name !== 'AbortError') setError(err); }
    finally { if (active.current) setPending(false); }
  };
  return <AuthShell title={user.must_change_password ? 'Set your password' : 'Change password'} description={user.must_change_password ? 'Replace your temporary password to continue.' : undefined}>
    <form className="login-form" onSubmit={submit}>
      <input type="hidden" name="username" autoComplete="username" value={user.username} />
      <PasswordInput id="current-password" label={user.must_change_password ? 'Temporary password' : 'Current password'} value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" maxLength={128} required disabled={pending} />
      <PasswordInput id="new-password" label="New password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} maxLength={128} required disabled={pending} />
      <PasswordInput id="confirm-password" label="Confirm new password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="new-password" minLength={8} maxLength={128} required disabled={pending} />
      <p className="form-hint">At least 8 characters. Other sessions will be signed out.</p>
      <ErrorMessage error={error} />
      <button className="btn btn-primary btn-block" disabled={pending}>{pending ? 'Saving…' : 'Save password'}</button>
    </form>
    <p className="login-help">{user.must_change_password ? <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={logout}>Sign out</button> : <Link to="/dashboard">Back to workspace</Link>}</p>
  </AuthShell>;
}
