import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../contexts/useAuth';
import AuthShell from '../components/AuthShell';
import PasswordInput from '../components/PasswordInput';
import ErrorMessage from '../components/ErrorMessage';
import { readRecoveryToken } from '../utils/recovery.js';

export function ForgotAdminPassword() {
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (event) => {
    event.preventDefault(); setError(null); setPending(true);
    try { await api.auth.requestAdminReset(); setSent(true); }
    catch (err) { setError(err); }
    finally { setPending(false); }
  };
  return <AuthShell title={sent ? 'Check your email' : 'Reset admin password'} description={sent ? 'If recovery is available, a reset link will be sent to the saved admin email. It expires in 15 minutes.' : 'Send a reset link to the saved admin email.'}>
    {!sent && <form className="login-form" onSubmit={submit}>
      <ErrorMessage error={error} />
      <button className="btn btn-primary btn-block" disabled={pending}>{pending ? 'Sending…' : 'Send reset link'}</button>
    </form>}
    <p className="login-help"><Link to="/login/admin">Back to admin sign in</Link></p>
  </AuthShell>;
}

export function ResetAdminPassword() {
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => readRecoveryToken(location.hash));
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const { clearSession } = useAuth();
  useEffect(() => {
    // Keep the token only in this page's memory, including after StrictMode remounts.
    if (location.hash || location.search) navigate(location.pathname, { replace: true });
  }, [location.hash, location.search, location.pathname, navigate]);
  const submit = async (event) => {
    event.preventDefault(); setError(null);
    if (password !== confirmation) { setError(new Error('The passwords do not match.')); return; }
    setPending(true);
    try {
      await api.auth.resetAdminPassword({ token, new_password: password, confirm_password: confirmation });
      clearSession(); setPassword(''); setConfirmation(''); setDone(true);
    } catch (err) { setError(err); }
    finally { setPending(false); }
  };
  return <AuthShell title={done ? 'Password updated' : 'Choose a new password'} description={done ? 'Sign in with your new password.' : undefined}>
    {done ? <Link className="btn btn-primary btn-block" to="/login/admin">Admin sign in</Link> : !token ? <>
      <ErrorMessage error={new Error('This reset link is invalid. Request a new link.')} />
      <p className="login-help"><Link to="/forgot-password">Request a reset link</Link></p>
    </> : <>
      <form className="login-form" onSubmit={submit}>
        <PasswordInput id="reset-password" label="New password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={8} maxLength={128} autoFocus required />
        <PasswordInput id="reset-confirm" label="Confirm password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" minLength={8} maxLength={128} required />
        <p className="form-hint">At least 8 characters.</p>
        <ErrorMessage error={error} />
        <button className="btn btn-primary btn-block" disabled={pending}>{pending ? 'Saving…' : 'Save password'}</button>
      </form>
      <p className="login-help"><Link to="/forgot-password">Request a new reset link</Link></p>
    </>}
  </AuthShell>;
}
