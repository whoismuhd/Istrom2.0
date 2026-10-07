const PREFIX = 'istrom_workspace:';
const VERSION = 1;
let sessionGeneration = 0;
const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
const secretField = (name) => /password|secret|token|access.?code/i.test(name);
const storageWarning = 'Changes could not be saved in this browser. Keep this tab open until you finish.';

export function workspaceOwner(user) {
  if (!['admin', 'project_site'].includes(user?.user_type) || !user.username) return null;
  return JSON.stringify([user.user_id ?? null, user.username, user.user_type,
    user.project_site || null, user.is_global_admin === true || (user.user_type === 'admin' && !user.project_site)]);
}

export function workspaceStateKey(user, projectSite, name, scope = 'site') {
  const owner = workspaceOwner(user);
  if (!owner || !/^[a-zA-Z0-9._-]+$/.test(name)) return null;
  const project = scope === 'account' ? '@account' : projectSite || '@all';
  return `${PREFIX}${encodeURIComponent(owner)}:${encodeURIComponent(project)}:${name}`;
}

export function workspaceGeneration() { return sessionGeneration; }

// Restore only the fields declared by the screen; credentials are never stored.
export function normalizeWorkspaceState(value, initial) {
  if (Array.isArray(initial)) {
    if (!Array.isArray(value) || value.length > 2000) throw new Error('Invalid saved state');
    return value.map((entry) => initial.length
      ? normalizeWorkspaceState(entry, initial[0]) : normalizeWorkspaceState(entry, null));
  }
  if (isObject(initial)) {
    if (!isObject(value)) throw new Error('Invalid saved state');
    return Object.fromEntries(Object.entries(initial).filter(([key]) => !secretField(key))
      .map(([key, fallback]) => [key, Object.hasOwn(value, key)
        ? normalizeWorkspaceState(value[key], fallback) : fallback]));
  }
  if (initial === null) {
    if (value === null || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 50000)
      || (typeof value === 'number' && Number.isFinite(value))) return value;
    throw new Error('Invalid saved state');
  }
  if (typeof value !== typeof initial || (typeof value === 'number' && !Number.isFinite(value))
    || (typeof value === 'string' && value.length > 50000)) throw new Error('Invalid saved state');
  return value;
}

export function readWorkspaceState(key, initial, validate, storage) {
  if (!key) return { value: initial, error: '' };
  try {
    const saved = (storage ?? globalThis.sessionStorage).getItem(key);
    if (!saved) return { value: initial, error: '' };
    const record = JSON.parse(saved);
    if (record?.version !== VERSION) throw new Error('Invalid saved state');
    const value = normalizeWorkspaceState(record.value, initial);
    if (validate && !validate(value)) throw new Error('Invalid saved state');
    return { value, error: '' };
  } catch {
    return { value: initial, error: 'Saved work could not be restored in this browser.' };
  }
}

export function writeWorkspaceState(key, value, initial, validate, storage) {
  if (!key) return 'Sign in to save this draft.';
  try {
    const safe = normalizeWorkspaceState(value, initial);
    if (validate && !validate(safe)) throw new Error('Invalid saved state');
    (storage ?? globalThis.sessionStorage).setItem(key, JSON.stringify({ version: VERSION, value: safe }));
    return '';
  } catch { return storageWarning; }
}

export function removeWorkspaceState(key, expected, initial, validate, storage) {
  if (!key) return { cleared: true, error: '' };
  try {
    const store = storage ?? globalThis.sessionStorage;
    const saved = store.getItem(key);
    if (saved) {
      const current = readWorkspaceState(key, initial, validate, store);
      if (!current.error && JSON.stringify(current.value) !== JSON.stringify(normalizeWorkspaceState(expected, initial))) {
        return { cleared: false, error: '' };
      }
    }
    store.removeItem(key);
    return { cleared: true, error: '' };
  } catch { return { cleared: false, error: storageWarning }; }
}

export function clearWorkspaceStates(storage) {
  sessionGeneration += 1;
  try {
    const store = storage ?? globalThis.sessionStorage;
    const keys = Array.from({ length: store.length }, (_, index) => store.key(index));
    for (const key of keys) if (key?.startsWith(PREFIX)) store.removeItem(key);
  } catch { /* Sign-out must complete even when browser storage is unavailable. */ }
}
