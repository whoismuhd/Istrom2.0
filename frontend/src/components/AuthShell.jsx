import Logo from './Logo';
import ThemeToggle from './ThemeToggle';
import '../pages/Login.css';

export default function AuthShell({ title, description, children }) {
  return <div className="login-page"><ThemeToggle className="login-theme-toggle" /><div className="login-split">
    <div className="login-brand"><div className="login-brand-content">
      <Logo className="login-logo" />
      <div className="login-brand-copy">
        <h2 className="login-brand-title">Inventory &amp; budgets</h2>
      </div>
    </div></div>
    <div className="login-form-panel"><div className="login-card">
      <div className="login-card-header"><h1>{title}</h1>{description && <p>{description}</p>}</div>
      {children}
    </div></div>
  </div></div>;
}
