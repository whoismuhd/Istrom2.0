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

function AccountIcon({ site = false }) {
  return <svg className="login-account-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {site ? <><path d="M3 21h18M5 21V9l7-5 7 5v12M9 21v-6h6v6M9 10h.01M15 10h.01" /><path d="M3 9 12 2l9 7" /></> : <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>}
  </svg>;
}

export default function Login() {
  const { user, loading, sessionError, retrySession } = useAuth();
  if (loading) return <div className="card" role="status">Loading...</div>;
  if (sessionError) return <LoadError error={sessionError} onRetry={retrySession} />;
  if (user) return <Navigate to="/" replace />;
  return <AuthShell title="Sign in" description="Select your account type.">
    <nav className="login-options" aria-label="Account type">
      <Link className="login-option" to="/login/admin">
        <AccountIcon />
        <div className="login-option-copy"><h2>Admin</h2><p>Projects, users and approvals</p></div>
        <svg className="login-option-arrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      </Link>
      <Link className="login-option" to="/login/site">
        <AccountIcon site />
        <div className="login-option-copy"><h2>Site user</h2><p>Requests and project records</p></div>
        <svg className="login-option-arrow" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      </Link>
    </nav>
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
    <nav className="login-role-switch" aria-label="Account type">
      <Link to="/login/admin" aria-current={admin ? 'page' : undefined}>Admin</Link>
      <Link to="/login/site" aria-current={!admin ? 'page' : undefined}>Site user</Link>
    </nav>
    <form onSubmit={submit} className="login-form">
      {admin ? <input type="hidden" name="username" autoComplete="username" value={ADMIN_USERNAME} /> : <div className="form-group"><label htmlFor="login-username">Username</label><input id="login-username" name="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Enter your username" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={80} autoFocus required /></div>}
      <PasswordInput id="login-password" name="password" label="Password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" autoComplete="current-password" autoFocus={admin} maxLength={128} required />
      <ErrorMessage error={error} />
      <button type="submit" className="btn btn-primary btn-block" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
    </form>
    {admin && setup.data?.setup_required && <p className="login-help"><Link to="/account-setup">Set up the first administrator account</Link></p>}
    {admin && setup.data && !setup.data.setup_required && <p className="login-help"><Link to="/forgot-password">Forgot password?</Link></p>}
    {admin && setup.error && <p className="login-help" role="alert">Could not check account setup. <button type="button" className="btn btn-secondary btn-sm" onClick={() => setup.refetch()}>Retry</button></p>}
    {!admin && <p className="login-help">Contact your administrator for access or a password reset.</p>}
  </AuthShell>;
}
