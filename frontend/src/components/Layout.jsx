import { useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/useAuth';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import useNotificationSocket from '../hooks/useNotificationSocket';
import Logo from './Logo';
import './Layout.css';

const Icons = {
  dashboard: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9"/>
      <rect x="14" y="3" width="7" height="5"/>
      <rect x="14" y="12" width="7" height="9"/>
      <rect x="3" y="16" width="7" height="5"/>
    </svg>
  ),
  entry: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  ),
  inventory: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
      <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
      <line x1="12" y1="22.08" x2="12" y2="12"/>
    </svg>
  ),
  request: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="16"/>
      <line x1="8" y1="12" x2="16" y2="12"/>
    </svg>
  ),
  review: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 11 12 14 22 4"/>
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
    </svg>
  ),
  budget: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/>
      <line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="6" y1="20" x2="6" y2="14"/>
    </svg>
  ),
  actuals: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
      <polyline points="17 6 23 6 23 12"/>
    </svg>
  ),
  upload: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  ),
  settings: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  ),
  bell: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
  ),
  menu: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="12" x2="21" y2="12"/>
      <line x1="3" y1="6" x2="21" y2="6"/>
      <line x1="3" y1="18" x2="21" y2="18"/>
    </svg>
  ),
  close: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  ),
  logout: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      <polyline points="16 17 21 12 16 7"/>
      <line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
  ),
  pin: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  ),
};

const ADMIN_TABS = [
  { path: '/dashboard', label: 'Control Tower', icon: 'dashboard' },
  { path: '/manual-entry', label: 'Manual Entry', icon: 'entry' },
  { path: '/bulk-upload', label: 'Import Workbook', icon: 'upload' },
  { path: '/inventory', label: 'Inventory', icon: 'inventory' },
  { path: '/request', label: 'Make Request', icon: 'request' },
  { path: '/review', label: 'Review & History', icon: 'review' },
  { path: '/budget-summary', label: 'Budget Summary', icon: 'budget' },
  { path: '/actuals', label: 'Actuals', icon: 'actuals' },
  { path: '/notifications', label: 'Notifications', icon: 'bell' },
  { path: '/settings', label: 'Admin Settings', icon: 'settings' },
];

const SITE_ADMIN_TABS = [
  { path: '/dashboard', label: 'Site Hub', icon: 'dashboard' },
  // { path: '/bulk-upload', label: 'Excel Viewer', icon: 'upload' },
  { path: '/manual-entry', label: 'Manual Entry', icon: 'entry' },
  { path: '/inventory', label: 'Inventory', icon: 'inventory' },
  { path: '/request', label: 'Make Request', icon: 'request' },
  { path: '/review', label: 'Review & History', icon: 'review' },
  { path: '/budget-summary', label: 'Budget Summary', icon: 'budget' },
  { path: '/actuals', label: 'Actuals', icon: 'actuals' },
  { path: '/notifications', label: 'Notifications', icon: 'bell' },
];

const PROJECT_TABS = [
  { path: '/dashboard', label: 'Site Hub', icon: 'dashboard' },
  // { path: '/bulk-upload', label: 'Excel Viewer', icon: 'upload' },
  { path: '/manual-entry', label: 'Manual Entry', icon: 'entry' },
  { path: '/inventory', label: 'Inventory', icon: 'inventory' },
  { path: '/request', label: 'Make Request', icon: 'request' },
  { path: '/review', label: 'Review & History', icon: 'review' },
  { path: '/budget-summary', label: 'Budget Summary', icon: 'budget' },
  { path: '/actuals', label: 'Actuals', icon: 'actuals' },
  { path: '/notifications', label: 'Notifications', icon: 'bell' },
];

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { user, logout, isAdmin, isGlobalAdmin, projectSite, setProjectSite } = useAuth();
  const navigate = useNavigate();
  const { isLive: isNotificationsLive } = useNotificationSocket();

  const { data: sites = [] } = useQuery({
    queryKey: ['projectSites'],
    queryFn: () => api.projectSites.list(),
    enabled: isGlobalAdmin,
  });

  const { data: notifications = [] } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.notifications.list(),
    refetchInterval: isNotificationsLive ? 120000 : 30000,
  });

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const tabs = isGlobalAdmin ? ADMIN_TABS : (isAdmin ? SITE_ADMIN_TABS : PROJECT_TABS);
  const displayName = user?.full_name || user?.username || 'User';
  const displayProject = isGlobalAdmin ? (projectSite || 'All Sites') : (user?.project_site || '—');
  const roleLabel = isGlobalAdmin ? 'Admin' : (isAdmin ? 'Site Admin' : 'Site');
  const roleClass = isGlobalAdmin ? 'role-global-admin' : (isAdmin ? 'role-site-admin' : 'role-project-site');
  const headerTagline = isGlobalAdmin ? 'Control Tower' : (isAdmin ? 'Site Operations' : 'Field Operations');

  return (
    <div className={`app-layout ${roleClass}`}>
      {/* ── Top Header ── */}
      <header className="app-header">
        <button
          className="hamburger-btn"
          onClick={() => setSidebarOpen((o) => !o)}
          aria-label="Toggle menu"
        >
          {sidebarOpen ? Icons.close : Icons.menu}
        </button>

        <div className="header-brand">
          <Logo className="header-logo" />
          <span className="header-tagline">{headerTagline}</span>
        </div>

        {isGlobalAdmin && (
          <div className="header-site-selector">
            {Icons.pin}
            <select
              value={projectSite ?? ''}
              onChange={(e) => setProjectSite(e.target.value || null)}
              className="site-select-header"
            >
              <option value="">All Sites</option>
              {sites.map((s) => (
                <option key={s.id} value={s.name}>{s.name}</option>
              ))}
            </select>
          </div>
        )}

        <div className="header-actions">
          {unreadCount > 0 && (
            <button
              className="notif-icon-btn"
              onClick={() => navigate('/notifications')}
              aria-label={`${unreadCount} unread notifications`}
            >
              {Icons.bell}
              <span className="notif-pip">{unreadCount > 9 ? '9+' : unreadCount}</span>
            </button>
          )}
          <div className="user-chip">
            <span className="user-chip-role">{roleLabel}</span>
            <span className="user-chip-name">{displayName}</span>
          </div>
          <button className="btn-header-logout" onClick={handleLogout}>
            {Icons.logout}
            <span className="logout-label">Logout</span>
          </button>
        </div>
      </header>

      {/* ── Mobile sidebar backdrop ── */}
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── Sidebar ── */}
      <aside className={`app-sidebar${sidebarOpen ? ' sidebar-open' : ''}`}>
        <div className="sidebar-site-block">
          <span className="sidebar-site-label">{isGlobalAdmin ? 'Monitoring Scope' : 'Active Site'}</span>
          <span className="sidebar-site-name">{displayProject}</span>
        </div>

        <nav className="sidebar-nav">
          {tabs.map((tab) => (
            <NavLink
              key={tab.path}
              to={tab.path}
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
              onClick={() => setSidebarOpen(false)}
            >
              <span className="sidebar-icon">{Icons[tab.icon]}</span>
              <span className="sidebar-link-label">{tab.label}</span>
              {tab.icon === 'bell' && unreadCount > 0 && (
                <span className="sidebar-notif-badge">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-footer-avatar">
            {displayName.charAt(0).toUpperCase()}
          </div>
          <div className="sidebar-footer-info">
            <span className="sidebar-footer-name">{displayName}</span>
            <span className="sidebar-footer-role">
              {isGlobalAdmin ? 'Administrator' : displayProject}
            </span>
          </div>
        </div>
      </aside>

      {/* ── Main Content ── */}
      <main className="app-main">
        <div className="page-shell">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
