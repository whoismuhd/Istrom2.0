import Logo from './Logo';
import ThemeToggle from './ThemeToggle';
import '../pages/Login.css';

function BuildingDrawing() {
  return <svg className="login-building" viewBox="0 0 520 410" fill="none" aria-hidden="true" focusable="false">
    <g className="login-building-guides" stroke="currentColor" strokeWidth="1">
      <path d="M32 286 270 396 493 285 255 175Z" />
      <path d="M90 256v52m180 31v55m145-127v47M60 300l210 97 173-86" />
      <path d="m56 294 8 12m202 85 8 12m165-98 8 12" />
      <path d="M64 121v135m-5-131 10-8m-10 143 10-8M78 122H54m24 134H54" />
    </g>
    <g stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round">
      <path className="login-building-face" d="M90 122 270 205v134L90 256Z" />
      <path className="login-building-side" d="m270 205 145-72v134l-145 72Z" />
      <path d="M90 122 235 50l180 83-145 72Z" />
      <path d="m90 115 145-72 180 83v7M90 115v7m180 76v7m-180-90 180 83 145-72" />
      <path d="m109 120 127-63 158 73-126 63Z" />
      <path className="login-building-roof" d="m194 78 43-21 47 22-43 22Z" />
      <path d="m241 101 112 52m-202-12 127-63" opacity=".45" />
      {[0, 1, 2].map((floor) => <g key={floor}>
        {[0, 1, 2, 3].map((column) => {
          const x = 101 + column * 44;
          const y = 139 + column * (83 / 180 * 44) + floor * 43;
          return <path key={column} d={`M${x} ${y}l25 11.53v25l-25-11.53Z`} />;
        })}
        {[0, 1, 2].map((column) => {
          const x = 283 + column * 45;
          const y = 215 - column * (72 / 145 * 45) + floor * 43;
          return <path key={column} d={`M${x} ${y}l26-12.91v25l-26 12.91Z`} />;
        })}
      </g>)}
      <path d="m90 166 180 83 145-72m-325 115 180 83 145-72" opacity=".55" />
      <path className="login-building-accent" d="m90 209 180 83 145-72" />
      <path d="m83 259 187 87 152-75m-339-5 187 87 152-75M83 259v7m187 80v7m152-82v7" />
    </g>
  </svg>;
}

export default function AuthShell({ title, description, children }) {
  return <div className="login-page">
    <ThemeToggle className="login-theme-toggle" />
    <div className="login-split">
      <aside className="login-brand">
        <Logo className="login-logo" />
        <div className="login-brand-copy">
          <p className="login-brand-label">Project operations</p>
          <h2 className="login-brand-title">Inventory,<br /> budgets &amp; requests</h2>
          <p className="login-brand-summary">Site requests, admin approvals and actual costs.</p>
        </div>
        <BuildingDrawing />
        <div className="login-brand-footer"><span />Istrom Group</div>
      </aside>
      <main className="login-form-panel">
        <div className="login-card">
          <div className="login-card-header"><h1>{title}</h1>{description && <p>{description}</p>}</div>
          {children}
        </div>
      </main>
    </div>
  </div>;
}
