import { useState } from 'react';
import { api } from '../api';
import { AuthContext } from './authStore';

function getStoredAuth() {
  const emptyAuth = { user: null, projectSite: null };
  const token = localStorage.getItem('istrom_token');
  const stored = localStorage.getItem('istrom_user');
  if (!token || !stored) return emptyAuth;

  try {
    const user = JSON.parse(stored);
    return {
      user,
      projectSite: user.user_type === 'admin' && user.project_site ? user.project_site : null,
    };
  } catch {
    localStorage.removeItem('istrom_token');
    localStorage.removeItem('istrom_user');
    return emptyAuth;
  }
}

export function AuthProvider({ children }) {
  const [initialAuth] = useState(getStoredAuth);
  const [user, setUser] = useState(initialAuth.user);
  const [projectSite, setProjectSite] = useState(initialAuth.projectSite); // Admin's selected project site
  const loading = false;
  const isGlobalAdmin = user?.user_type === 'admin'
    && (user?.is_global_admin === true || !user?.project_site);

  const login = async (accessCode) => {
    const res = await api.auth.login(accessCode);
    if (res.success && res.token) {
      localStorage.setItem('istrom_token', res.token);
      localStorage.setItem('istrom_user', JSON.stringify(res.user));
      setUser(res.user);
      if (res.user.user_type === 'admin' && res.user.project_site) {
        setProjectSite(res.user.project_site);
      } else {
        setProjectSite(null);
      }
      return res;
    }
    return res;
  };

  const logout = () => {
    localStorage.removeItem('istrom_token');
    localStorage.removeItem('istrom_user');
    setUser(null);
    setProjectSite(null);
  };

  const getEffectiveProjectSite = () => {
    if (user?.user_type === 'project_site') return user.project_site;
    if (user?.user_type === 'admin' && !isGlobalAdmin) return user.project_site;
    if (projectSite === '' || projectSite === null) return null; // All sites for admin
    return projectSite || user?.project_site || 'Lifecamp Kafe';
  };

  const value = {
    user,
    loading,
    login,
    logout,
    projectSite,
    setProjectSite,
    getEffectiveProjectSite,
    isAdmin: user?.user_type === 'admin',
    isGlobalAdmin,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
