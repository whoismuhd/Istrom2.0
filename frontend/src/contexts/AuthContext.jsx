import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { AuthContext } from './authStore';
import { disablePush } from '../push';

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
  const queryClient = useQueryClient();
  const [initialAuth] = useState(getStoredAuth);
  const [user, setUser] = useState(initialAuth.user);
  const [projectSite, setProjectSite] = useState(initialAuth.projectSite); // Admin's selected project site
  const [loading, setLoading] = useState(Boolean(initialAuth.user));
  useEffect(() => {
    const refreshSharedSession = (event) => {
      if (event.storageArea === localStorage && ['istrom_token', 'istrom_user', null].includes(event.key)) {
        queryClient.clear();
        window.location.reload();
      }
    };
    window.addEventListener('storage', refreshSharedSession);
    return () => window.removeEventListener('storage', refreshSharedSession);
  }, [queryClient]);
  useEffect(() => {
    if (!initialAuth.user) return;
    let active = true;
    api.auth.me().then((identity) => {
      if (!active) return;
      localStorage.setItem('istrom_user', JSON.stringify(identity));
      setUser(identity);
      setProjectSite(identity.user_type === 'admin' && identity.project_site ? identity.project_site : null);
    }).catch(() => {
      if (!active) return;
      localStorage.removeItem('istrom_token');
      localStorage.removeItem('istrom_user');
      setUser(null);
      setProjectSite(null);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [initialAuth]);
  const isGlobalAdmin = user?.user_type === 'admin'
    && (user?.is_global_admin === true || !user?.project_site);

  const acceptSession = (res) => {
    if (res.success && res.token) {
      queryClient.clear();
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

  const login = async (credentials) => acceptSession(await api.auth.login(credentials));
  const setupAdmin = async (details) => acceptSession(await api.auth.setup(details));
  const changePassword = async (details) => acceptSession(await api.auth.changePassword(details));

  const logout = async () => {
    try {
      await disablePush();
    } catch {
      // Local sign-out still completes if the subscription service is offline.
    }
    queryClient.clear();
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
    setupAdmin,
    changePassword,
    logout,
    projectSite,
    setProjectSite,
    getEffectiveProjectSite,
    isAdmin: user?.user_type === 'admin',
    isSiteUser: user?.user_type === 'project_site',
    isGlobalAdmin,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
