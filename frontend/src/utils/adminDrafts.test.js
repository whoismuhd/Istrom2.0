import test from 'node:test';
import assert from 'node:assert/strict';
import { USER_DRAFT, PROJECT_EDIT_DRAFT, isUserDraft, isProjectEditDraft, userDraftFor, projectEditDraftFor, userDraftChanged, projectEditDraftChanged, userExpectedState, projectExpectedState, adminDraftReview, isAdminDraftReviewCurrent } from './adminDrafts.js';
import { workspaceStateKey, writeWorkspaceState, readWorkspaceState, removeWorkspaceState } from './workspaceState.js';

const account = { id: 11, username: 'site.user', user_type: 'project_site', project_site: 'A', is_active: true };
const site = { id: 21, name: 'A', description: 'Original scope' };
const admin = { user_id: 1, username: 'Istrom_Admin', user_type: 'admin', project_site: null, is_global_admin: true };

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

test('user edit drafts contain scalar baselines and preserve a safe unsaved status choice', () => {
  const draft = { ...userDraftFor('edit', account), project_site: 'B', activeChoice: false };
  assert.equal(isUserDraft(draft), true);
  assert.equal(draft.baseProjectSite, 'A');
  assert.equal(draft.baseIsActive, true);
  assert.equal(isUserDraft({ ...draft, password: 'must stay in memory' }), false);
  assert.equal(isUserDraft({ ...draft, activeChoice: 'disabled' }), false);
  assert.equal(isUserDraft({ ...draft, account }), false);
});

test('user drafts detect fresh assignment, role or status changes without altering the draft', () => {
  const draft = { ...userDraftFor('edit', account), project_site: 'B', activeChoice: false };
  const before = JSON.stringify(draft);
  assert.equal(userDraftChanged(draft, account), false);
  for (const changed of [{ ...account, project_site: 'C' }, { ...account, is_active: false }, { ...account, user_type: 'admin', project_site: null }]) {
    assert.equal(userDraftChanged(draft, changed), true);
  }
  assert.equal(JSON.stringify(draft), before);
  assert.equal(userDraftChanged(userDraftFor('reset', account), { ...account, project_site: 'C' }), false);
});

test('legacy unassigned accounts and administrator assignments produce valid expected state', () => {
  for (const record of [{ ...account, project_site: null, is_active: false }, { ...account, user_type: 'admin', project_site: null }]) {
    const draft = userDraftFor('edit', record);
    assert.equal(isUserDraft(draft), true);
    assert.equal(userDraftChanged(draft, record), false);
    assert.equal(userExpectedState(record).project_site, null);
  }
});

test('user review expires after refresh, another server change or another draft baseline', () => {
  const draft = userDraftFor('edit', account);
  const changed = { ...account, project_site: 'C' };
  const review = adminDraftReview('user', draft, changed);
  assert.equal(isAdminDraftReviewCurrent('user', draft, changed, null), false);
  assert.equal(isAdminDraftReviewCurrent('user', draft, changed, review), true);
  assert.equal(isAdminDraftReviewCurrent('user', draft, { ...changed, is_active: false }, review), false);
  assert.equal(isAdminDraftReviewCurrent('user', { ...draft, baseProjectSite: 'B' }, changed, review), false);
  assert.equal(isAdminDraftReviewCurrent('user', draft, { ...changed, id: 12 }, review), false);
  assert.equal(isUserDraft({ ...draft, reviewed: true }), false);
});

test('project drafts detect changes to current name, description and activity', () => {
  const draft = { ...projectEditDraftFor(site), name: 'Draft A', description: 'Draft scope' };
  assert.equal(isProjectEditDraft(draft), true);
  assert.equal(projectEditDraftChanged(draft, site), false);
  for (const changed of [{ ...site, name: 'Current A' }, { ...site, description: 'Current scope' }, { ...site, is_active: false }]) {
    assert.equal(projectEditDraftChanged(draft, changed), true);
  }
  assert.equal(draft.name, 'Draft A');
  assert.equal(draft.baseName, 'A');
  assert.equal(isProjectEditDraft({ ...draft, site }), false);
  assert.equal(isProjectEditDraft({ ...draft, baseDescription: null }), false);
});

test('empty and null descriptions are equivalent for project review and expected state', () => {
  const record = { ...site, description: null };
  const draft = projectEditDraftFor(record);
  assert.equal(draft.baseDescription, '');
  assert.equal(projectEditDraftChanged(draft, { ...record, description: '' }), false);
  assert.deepEqual(projectExpectedState(record), { name: 'A', description: '', is_active: true });
});

test('project review acknowledges only the current record and baseline in this session', () => {
  const draft = projectEditDraftFor(site);
  const changed = { ...site, name: 'Current A' };
  const review = adminDraftReview('project', draft, changed);
  assert.equal(isAdminDraftReviewCurrent('project', draft, changed, review), true);
  assert.equal(isAdminDraftReviewCurrent('project', draft, changed, null), false);
  assert.equal(isAdminDraftReviewCurrent('project', draft, { ...changed, description: 'Changed again' }, review), false);
  assert.equal(isAdminDraftReviewCurrent('project', { ...draft, baseName: 'Earlier name' }, changed, review), false);
  assert.equal(isProjectEditDraft({ ...draft, reviewed: review }), false);
});

for (const [name, initial, validate, draft] of [
  ['users-draft', USER_DRAFT, isUserDraft, { ...userDraftFor('edit', account), project_site: 'B', activeChoice: false }],
  ['settings-site-edit', PROJECT_EDIT_DRAFT, isProjectEditDraft, { ...projectEditDraftFor(site), description: 'Draft scope' }],
]) {
  test(`${name} refresh preserves the safe draft and successful save or Cancel clears it`, () => {
    const store = storage();
    const key = workspaceStateKey(admin, null, name, 'account');
    assert.equal(writeWorkspaceState(key, draft, initial, validate, store), '');
    assert.deepEqual(readWorkspaceState(key, initial, validate, store), { value: draft, error: '' });
    assert.deepEqual(removeWorkspaceState(key, draft, initial, validate, store), { cleared: true, error: '' });
    assert.deepEqual(readWorkspaceState(key, initial, validate, store), { value: initial, error: '' });
  });

  test(`${name} delayed save does not clear newer edits or store passwords/acknowledgements`, () => {
    const store = storage();
    const key = workspaceStateKey(admin, null, name, 'account');
    assert.equal(writeWorkspaceState(key, { ...draft, password: 'must stay in memory', reviewed: true }, initial, validate, store), '');
    assert.deepEqual(readWorkspaceState(key, initial, validate, store).value, draft);
    const newer = { ...draft, ...(name === 'users-draft' ? { project_site: 'C', activeChoice: true } : { name: 'Newer name' }) };
    assert.equal(writeWorkspaceState(key, newer, initial, validate, store), '');
    assert.deepEqual(removeWorkspaceState(key, draft, initial, validate, store), { cleared: false, error: '' });
    assert.deepEqual(readWorkspaceState(key, initial, validate, store).value, newer);
  });
}
