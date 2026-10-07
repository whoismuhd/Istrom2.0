import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { AuthContext } from './authStore';
import { disablePush } from '../push';
import { isGlobalAdministrator, readProjectSelection, saveProjectSelection, validateProjectSelection } from '../utils/workspace';

function getStoredAuth() {
  // Retire the old shared login; each tab now signs in independently.
  try {
    localStorage.removeItem('istrom_token');
    localStorage.removeItem('istrom_user');
  } catch { /* Browser storage may be restricted. */ }
  const emptyAuth = { user: null, projectSite: null };
  const token = sessionStorage.getItem('istrom_token');
  const stored = sessionStorage.getItem('istrom_user');
  if (!token || !stored) return emptyAuth;

  try {
    const user = JSON.parse(stored);
    return {
      user,
      projectSite: readProjectSelection(user),
    };
  } catch {
    sessionStorage.removeItem('istrom_token');
    sessionStorage.removeItem('istrom_user');
    return emptyAuth;
  }
}

export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  const [initialAuth] = useState(getStoredAuth);
  const [user, setUser] = useState(null);
  const [projectSite, setProjectSiteState] = useState(initialAuth.projectSite);
  const [loading, setLoading] = useState(Boolean(initialAuth.user));
  const [sessionError, setSessionError] = useState(null);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  useEffect(() => {
    if (!initialAuth.user) return;
    let active = true;
    const startingToken = sessionStorage.getItem('istrom_token');
    api.auth.me().then(async (identity) => {
      if (!active || sessionStorage.getItem('istrom_token') !== startingToken) return;
      if (!['admin', 'project_site'].includes(identity?.user_type)) {
        throw new Error('Could not verify your sign-in. Please try again.');
      }
      let selection = readProjectSelection(identity);
      if (isGlobalAdministrator(identity) && selection) {
        const sites = await api.projectSites.list({ redirectOnUnauthorized: false });
        if (!active || sessionStorage.getItem('istrom_token') !== startingToken) return;
        if (!Array.isArray(sites)) throw new Error('Could not load your project sites. Please try again.');
        selection = validateProjectSelection(identity, sites);
      }
      sessionStorage.setItem('istrom_user', JSON.stringify(identity));
      setUser(identity);
      setProjectSiteState(selection);
      setSessionError(null);
    }).catch((error) => {
      if (!active || sessionStorage.getItem('istrom_token') !== startingToken) return;
      setUser(null);
      if (error.status === 401 || error.status === 403) {
        queryClient.clear();
        sessionStorage.removeItem('istrom_token');
        sessionStorage.removeItem('istrom_user');
        setProjectSiteState(null);
        setSessionError(null);
      } else {
        setSessionError(error);
      }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [initialAuth, sessionAttempt, queryClient]);
  const isGlobalAdmin = isGlobalAdministrator(user);

  const retrySession = () => {
    setSessionError(null);
    setLoading(true);
    setSessionAttempt((attempt) => attempt + 1);
  };

  const setProjectSite = useCallback((site) => {
    setProjectSiteState(saveProjectSelection(user, site));
  }, [user]);

  const acceptSession = (res) => {
    if (res.success && res.token) {
      queryClient.clear();
      sessionStorage.setItem('istrom_token', res.token);
      sessionStorage.setItem('istrom_user', JSON.stringify(res.user));
      setUser(res.user);
      setProjectSiteState(readProjectSelection(res.user));
      setSessionError(null);
      setLoading(false);
      return res;
    }
    return res;
  };

  const login = async (credentials) => acceptSession(await api.auth.login(credentials));
  const setupAdmin = async (details) => acceptSession(await api.auth.setup(details));
  const changePassword = async (details) => acceptSession(await api.auth.changePassword(details));

  const clearSession = () => {
    queryClient.clear();
    sessionStorage.removeItem('istrom_token');
    sessionStorage.removeItem('istrom_user');
    saveProjectSelection(user || initialAuth.user, null);
    setUser(null);
    setProjectSiteState(null);
    setSessionError(null);
    setLoading(false);
  };

  const logout = async () => {
    try {
      await disablePush({signingOut:true});
    } catch {
      // Local sign-out still completes if the subscription service is offline.
    }
    clearSession();
  };

  const getEffectiveProjectSite = () => {
    if (user?.user_type === 'project_site') return user.project_site;
    if (user?.user_type === 'admin' && !isGlobalAdmin) return user.project_site;
    return projectSite || null;
  };

  const value = {
    user,
    loading,
    sessionError,
    retrySession,
    login,
    setupAdmin,
    changePassword,
    logout,
    clearSession,
    projectSite,
    setProjectSite,
    getEffectiveProjectSite,
    isAdmin: user?.user_type === 'admin',
    isSiteUser: user?.user_type === 'project_site',
    isGlobalAdmin,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
