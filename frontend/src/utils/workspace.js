export function isGlobalAdministrator(user) {
  return user?.user_type === 'admin'
    && (user.is_global_admin === true || !user.project_site);
}

function selectionKey(user) {
  const account = user?.user_id ?? user?.username;
  return account == null ? null : `istrom_project_site:${account}`;
}

function normalizeProject(site) {
  return typeof site === 'string' && site.length > 0 && site.length <= 255 ? site : null;
}

export function readProjectSelection(user, storage) {
  if (!isGlobalAdministrator(user)) return user?.project_site || null;
  try {
    const key = selectionKey(user);
    return key ? normalizeProject((storage ?? globalThis.sessionStorage).getItem(key)) : null;
  } catch {
    return null;
  }
}

export function saveProjectSelection(user, site, storage) {
  if (!isGlobalAdministrator(user)) return user?.project_site || null;
  const selection = normalizeProject(site);
  try {
    const key = selectionKey(user);
    const store = storage ?? globalThis.sessionStorage;
    if (key && selection) store.setItem(key, selection);
    else if (key) store.removeItem(key);
  } catch {
    // Project selection still works if the browser blocks storage.
  }
  return selection;
}

export function validateProjectSelection(user, sites, storage) {
  const selection = readProjectSelection(user, storage);
  if (isGlobalAdministrator(user) && selection && !sites.some((site) => site.name === selection)) {
    return saveProjectSelection(user, null, storage);
  }
  return selection;
}
