import Logo from './Logo';
import ThemeToggle from './ThemeToggle';
import '../pages/Login.css';

export default function AuthShell({ title, description, children }) {
  return <div className="login-page"><ThemeToggle className="login-theme-toggle" /><div className="login-split">
    <div className="login-brand"><div className="login-brand-content">
      <Logo className="login-logo" />
      <div className="login-brand-copy">
        <span className="login-eyebrow">Project management</span>
        <h2 className="login-brand-title">Project inventory<br />and cost control.</h2>
        <p className="login-brand-tagline">Manage materials, review requests, and track project budgets in one workspace.</p>
      </div>
      <div className="login-brand-footer">Inventory &nbsp; / &nbsp; Requests &nbsp; / &nbsp; Budgets</div>
    </div></div>
    <div className="login-form-panel"><div className="login-card">
      <div className="login-card-header"><h1>{title}</h1>{description && <p>{description}</p>}</div>
      {children}
    </div></div>
  </div></div>;
}
