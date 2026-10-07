const objectWithKeys = (value, initial) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).every((key) => Object.hasOwn(initial, key));
const text = (value, limit) => typeof value === 'string' && value.length <= limit;
const same = (left, right) => Object.keys(left).every((key) => left[key] === right?.[key]);
const siteName = (value) => value.project_site || '';
const description = (value) => value.description || '';

export const USER_DRAFT = {
  mode: '', accountId: 0, username: '', user_type: 'project_site', project_site: '',
  activeChoice: null, baseUserType: 'project_site', baseProjectSite: '', baseIsActive: true,
};
export const PROJECT_EDIT_DRAFT = {
  id: 0, name: '', description: '', baseName: '', baseDescription: '', baseIsActive: true,
};

export function isUserDraft(value) {
  return objectWithKeys(value, USER_DRAFT)
    && ['', 'create', 'edit', 'reset'].includes(value.mode)
    && Number.isSafeInteger(value.accountId) && value.accountId >= 0
    && (['', 'create'].includes(value.mode) ? value.accountId === 0 : value.accountId > 0)
    && ['admin', 'project_site'].includes(value.user_type)
    && ['admin', 'project_site'].includes(value.baseUserType)
    && text(value.username, 80) && text(value.project_site, 255)
    && (value.activeChoice === null || typeof value.activeChoice === 'boolean')
    && text(value.baseProjectSite, 255) && typeof value.baseIsActive === 'boolean';
}

export function isProjectEditDraft(value) {
  return objectWithKeys(value, PROJECT_EDIT_DRAFT)
    && Number.isSafeInteger(value.id) && value.id >= 0
    && text(value.name, 255) && text(value.description, 2000)
    && text(value.baseName, 255) && text(value.baseDescription, 2000)
    && typeof value.baseIsActive === 'boolean'
    && (value.id > 0 || same(PROJECT_EDIT_DRAFT, value));
}

export function userDraftFor(mode, account = null) {
  return {
    ...USER_DRAFT, mode, accountId: account?.id || 0, username: account?.username || '',
    user_type: account?.user_type || 'project_site', project_site: account ? siteName(account) : '',
    baseUserType: account?.user_type || 'project_site', baseProjectSite: account ? siteName(account) : '',
    baseIsActive: account?.is_active ?? true,
  };
}

export function projectEditDraftFor(site) {
  return {
    id: site.id, name: site.name, description: description(site),
    baseName: site.name, baseDescription: description(site), baseIsActive: site.is_active !== false,
  };
}

export function userDraftChanged(draft, account) {
  return draft.mode === 'edit' && Boolean(account) && (
    draft.baseUserType !== account.user_type || draft.baseProjectSite !== siteName(account)
    || draft.baseIsActive !== account.is_active);
}

export function projectEditDraftChanged(draft, site) {
  return Boolean(site) && (draft.baseName !== site.name || draft.baseDescription !== description(site)
    || draft.baseIsActive !== (site.is_active !== false));
}

export function userExpectedState(account) {
  return { user_type: account.user_type, project_site: account.project_site || null, is_active: account.is_active };
}

export function projectExpectedState(site) {
  return { name: site.name, description: description(site), is_active: site.is_active !== false };
}

// Acknowledgement belongs to this render session. It is never part of a saved draft.
export function adminDraftReview(kind, draft, record) {
  return kind === 'user' ? {
    id: record.id, baseRole: draft.baseUserType, baseSite: draft.baseProjectSite,
    baseActive: draft.baseIsActive, ...userExpectedState(record),
  } : {
    id: record.id, baseName: draft.baseName, baseDescription: draft.baseDescription,
    baseActive: draft.baseIsActive, ...projectExpectedState(record),
  };
}

export function isAdminDraftReviewCurrent(kind, draft, record, review) {
  return Boolean(record && review) && same(adminDraftReview(kind, draft, record), review);
}
