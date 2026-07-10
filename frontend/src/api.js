/** API client for Istrom Inventory Management System */

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function getToken() {
  return localStorage.getItem('istrom_token');
}

function getAuthHeaders() {
  const token = getToken();
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
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
  if (res.status === 401) {
    localStorage.removeItem('istrom_token');
    localStorage.removeItem('istrom_user');
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const msg = Array.isArray(data.detail) ? data.detail.map((d) => d.msg).join(', ') : (data.detail || data.message || 'Request failed');
    throw new Error(msg);
  }
  return data;
}

export const api = {
  auth: {
    login: (accessCode) =>
      request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ access_code: accessCode }),
      }),
  },

  push: {
    vapidPublicKey: () => request('/push/vapid-public-key'),
    subscribe: (subscription) =>
      request('/push/subscribe', { method: 'POST', body: JSON.stringify(subscription) }),
    unsubscribe: (endpoint) =>
      request('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) }),
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
    list: () => request('/notifications'),
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
      if (!res.ok) throw new Error('Could not download the template');
      return res.blob();
    },
    analyze: ({ file, projectSite }) => {
      const form = new FormData();
      form.append('file', file);
      form.append('project_site', projectSite);
      return request('/bulk-upload/analyze', { method: 'POST', body: form });
    },
    commit: ({ projectSite, skipExisting, rows }) =>
      request('/bulk-upload/commit', {
        method: 'POST',
        body: JSON.stringify({ project_site: projectSite, skip_existing: skipExisting, rows }),
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
    getAccessCode: (id) => request(`/project-sites/${id}/access-code`),
    updateAccessCode: (id, userCode) =>
      request(`/project-sites/${id}/access-code`, {
        method: 'PATCH',
        body: JSON.stringify({ user_code: userCode }),
      }),
  },

  accessCodes: {
    get: () => request('/access-codes'),
    update: (adminCode) =>
      request('/access-codes', {
        method: 'PATCH',
        body: JSON.stringify({ admin_code: adminCode }),
      }),
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
      const q = new URLSearchParams(params).toString();
      return request(`/deleted-requests${q ? '?' + q : ''}`);
    },
    clear: () => request('/deleted-requests', { method: 'DELETE' }),
  },
};

export function formatNaira(n) {
  if (n == null || isNaN(n)) return '₦0.00';
  return '₦' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatDate(dateStr, includeTime = true) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  if (!includeTime) return `${day}/${month}/${year}`;
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year}, ${hours}:${mins}`;
}
