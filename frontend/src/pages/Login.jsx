import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/useAuth';
import { api } from '../api';
import AuthShell from '../components/AuthShell';
import PasswordInput from '../components/PasswordInput';
import ErrorMessage from '../components/ErrorMessage';
import LoadError from '../components/LoadError';
import { ADMIN_USERNAME } from '../utils/accounts';

export default function Login() {
  const { user, loading, sessionError, retrySession } = useAuth();
  if (loading) return <div className="card" role="status">Loading...</div>;
  if (sessionError) return <LoadError error={sessionError} onRetry={retrySession} />;
  if (user) return <Navigate to="/" replace />;
  return <AuthShell title="Sign in to your workspace" description="Choose your account type to continue.">
    <div className="login-options">
      <Link className="login-option" to="/login/admin">
        <div><h2>Admin</h2><p>Manage projects, users and approvals.</p></div>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      </Link>
      <Link className="login-option" to="/login/site">
        <div><h2>Site user</h2><p>View your project and submit requests.</p></div>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      </Link>
    </div>
  </AuthShell>;
}

export function PortalLogin({ role }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const { login, user, loading, sessionError, retrySession } = useAuth();
  const admin = role === 'admin';
  const setup = useQuery({ queryKey: ['accountSetup'], queryFn: api.auth.setupStatus, enabled: admin, retry: false });
  if (loading) return <div className="card" role="status">Loading...</div>;
  if (sessionError) return <LoadError error={sessionError} onRetry={retrySession} />;
  if (user) return <Navigate to="/" replace />;
  const submit = async (event) => {
    event.preventDefault(); setError(null); setPending(true);
    try { await login({ ...(admin ? {} : { username }), password, user_type: role }); }
    catch (err) { setError(err); }
    finally { setPending(false); }
  };
  return <AuthShell title={admin ? 'Admin sign in' : 'Site user sign in'}>
    <form onSubmit={submit} className="login-form">
      {admin ? <input type="hidden" name="username" autoComplete="username" value={ADMIN_USERNAME} /> : <div className="form-group"><label htmlFor="login-username">Username</label><input id="login-username" name="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Enter your username" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={80} autoFocus required /></div>}
      <PasswordInput id="login-password" name="password" label="Password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" autoComplete="current-password" autoFocus={admin} maxLength={128} required />
      <ErrorMessage error={error} />
      <button type="submit" className="btn btn-primary btn-block" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
    </form>
    {admin && setup.data?.setup_required && <p className="login-help"><Link to="/account-setup">Set up the first administrator account</Link></p>}
    {admin && setup.data && !setup.data.setup_required && <p className="login-help"><Link to="/forgot-password">Forgot password?</Link></p>}
    {admin && setup.error && <p className="login-help" role="alert">Could not check account setup. <button type="button" className="btn btn-secondary btn-sm" onClick={() => setup.refetch()}>Retry</button></p>}
    <p className="login-help"><Link to="/login">Choose another account type</Link></p>
    {!admin && <p className="login-help">For access or password resets, contact your administrator.</p>}
  </AuthShell>;
}
