import { parseApiDate } from './utils/dates.js';
/** API client for Istrom Inventory Management System */

const API_BASE = (import.meta.env?.VITE_API_URL || '/api').replace(/\/+$/, '');

export function expireSession() {
  localStorage.removeItem('istrom_token');
  localStorage.removeItem('istrom_user');
  window.location.href = '/login';
}

function getToken() {
  return localStorage.getItem('istrom_token');
}

function getAuthHeaders() {
  const token = getToken();
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

function queryString(params = {}) {
  return new URLSearchParams(Object.fromEntries(
    Object.entries(params || {}).filter(([, value]) => value != null && value !== '')
  )).toString();
}

function validationMessage(detail) {
  const location = Array.isArray(detail.loc) ? detail.loc : [];
  const rowIndex = location.indexOf('rows');
  const row = rowIndex >= 0 && Number.isInteger(location[rowIndex + 1])
    ? `Row ${location[rowIndex + 1] + 1}, ` : '';
  const field = location.filter((part) => typeof part === 'string' && !['body', 'query', 'path', 'rows'].includes(part)).at(-1);
  const label = field ? field.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase()) : '';
  return `${row}${label ? `${label}: ` : ''}${detail.msg || 'Invalid value'}`;
}

async function request(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const baseHeaders = isFormData
    ? getAuthHeaders()
    : { 'Content-Type': 'application/json', ...getAuthHeaders() };
  const res = await fetch(url, {
    ...options,
    headers: { ...baseHeaders, ...options.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !['/auth/login', '/auth/setup'].includes(path)) {
    expireSession();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const msg = Array.isArray(data.detail) ? data.detail.map(validationMessage).join('; ') : (data.detail || data.message || 'Request failed');
    throw new Error(msg);
  }
  return data;
}

export const api = {
  auth: {
    me: () => request('/auth/me'),
    setupStatus: () => request('/auth/setup-status'),
    setup: (data) => request('/auth/setup', { method: 'POST', body: JSON.stringify(data) }),
    changePassword: (data) => request('/auth/password', { method: 'POST', body: JSON.stringify(data) }),
    login: (credentials) =>
      request('/auth/login', {
        method: 'POST',
        body: JSON.stringify(credentials),
      }),
  },

  users: {
    list: () => request('/users'),
    create: (data) => request('/users', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    resetPassword: (id, password) => request(`/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) }),
  },

  push: {
    vapidPublicKey: () => request('/push/vapid-public-key'),
    subscribe: (subscription) =>
      request('/push/subscribe', { method: 'POST', body: JSON.stringify(subscription) }),
    unsubscribe: (subscription) =>
      request('/push/unsubscribe', { method: 'POST', body: JSON.stringify(subscription), signal: AbortSignal.timeout(3000) }),
  },

  items: {
    list: (params = {}) => {
      const clean = Object.fromEntries(
        Object.entries(params).filter(([, v]) => v != null && v !== '')
      );
      const q = new URLSearchParams(clean).toString();
      return request(`/items${q ? '?' + q : ''}`);
    },
    get: (id) => request(`/items/${id}`),
    create: (data) => request('/items', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/items/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id) => request(`/items/${id}`, { method: 'DELETE' }),
  },

  requests: {
    list: (params = {}) => {
      const clean = Object.fromEntries(
        Object.entries(params || {}).filter(([, v]) => v != null && v !== '')
      );
      const q = new URLSearchParams(clean).toString();
      return request(`/requests${q ? '?' + q : ''}`);
    },
    create: (data) => request('/requests', { method: 'POST', body: JSON.stringify(data) }),
    updateStatus: (id, data) =>
      request(`/requests/${id}/status`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id) => request(`/requests/${id}`, { method: 'DELETE' }),
  },

  notifications: {
    list: (params = {}) => request(`/notifications?${queryString(params)}`),
    markRead: (id) => request(`/notifications/${id}/read`, { method: 'POST' }),
    delete: (id) => request(`/notifications/${id}`, { method: 'DELETE' }),
    clearAll: () => request('/notifications', { method: 'DELETE' }),
  },

  bulkUpload: {
    template: () => request('/bulk-upload/template'),
    view: ({ file }) => {
      const form = new FormData();
      form.append('file', file);
      return request('/bulk-upload/view', { method: 'POST', body: form });
    },
    preview: ({ file, defaultProjectSite }) => {
      const form = new FormData();
      form.append('file', file);
      if (defaultProjectSite) form.append('default_project_site', defaultProjectSite);
      return request('/bulk-upload/preview', { method: 'POST', body: form });
    },
    downloadTemplate: async () => {
      const res = await fetch(`${API_BASE}/bulk-upload/template.xlsx`, { headers: getAuthHeaders() });
      if (res.status === 401) {
        expireSession();
        throw new Error('Session expired');
      }
      if (!res.ok) throw new Error('Could not download the template');
      return res.blob();
    },
    analyze: ({ file, projectSite, mappings }) => {
      const form = new FormData();
      form.append('file', file);
      form.append('project_site', projectSite);
      if (mappings) form.append('mappings', JSON.stringify(mappings));
      return request('/bulk-upload/analyze', { method: 'POST', body: form });
    },
    commit: ({ projectSite, skipExisting, rows, previewToken, sheetChecks }) =>
      request('/bulk-upload/commit', {
        method: 'POST',
        body: JSON.stringify({ project_site: projectSite, skip_existing: skipExisting, rows, preview_token: previewToken, sheet_checks: sheetChecks }),
      }),
  },

  actuals: {
    list: (params = {}) => {
      const clean = Object.fromEntries(
        Object.entries(params || {}).filter(([, v]) => v != null && v !== '')
      );
      const q = new URLSearchParams(clean).toString();
      return request(`/actuals${q ? '?' + q : ''}`);
    },
    create: (data) => request('/actuals', { method: 'POST', body: JSON.stringify(data) }),
    delete: (id) => request(`/actuals/${id}`, { method: 'DELETE' }),
  },

  projectSites: {
    list: () => request('/project-sites'),
    create: (data) => request('/project-sites', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) =>
      request(`/project-sites/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id) => request(`/project-sites/${id}`, { method: 'DELETE' }),
  },

  accessLogs: {
    list: (params = {}) => {
      const clean = Object.fromEntries(
        Object.entries(params || {}).filter(([, v]) => v != null && v !== '')
      );
      const q = new URLSearchParams(clean).toString();
      return request(`/access-logs${q ? '?' + q : ''}`);
    },
    clear: () => request('/access-logs', { method: 'DELETE' }),
  },

  constants: {
    get: () => request('/constants'),
  },

  deletedRequests: {
    list: (params = {}) => {
      const q = queryString(params);
      return request(`/deleted-requests${q ? '?' + q : ''}`);
    },
    clear: (params = {}) => {
      const q = queryString(params);
      return request(`/deleted-requests${q ? '?' + q : ''}`, { method: 'DELETE' });
    },
  },
};

export function formatNaira(n) {
  if (n == null || isNaN(n)) return '₦0.00';
  return '₦' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatDate(dateStr, includeTime = true) {
  if (!dateStr) return '';
  const d = parseApiDate(dateStr);
  if (isNaN(d.getTime())) return '';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  if (!includeTime) return `${day}/${month}/${year}`;
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year}, ${hours}:${mins}`;
}
