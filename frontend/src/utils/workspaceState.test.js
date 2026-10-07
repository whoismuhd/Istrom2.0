import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceOwner, workspaceStateKey, workspaceGeneration, normalizeWorkspaceState,
  readWorkspaceState, writeWorkspaceState, removeWorkspaceState, clearWorkspaceStates } from './workspaceState.js';

const admin = { user_id: 1, username: 'Istrom_Admin', user_type: 'admin', project_site: null, is_global_admin: true };
const initial = { name: '', qty: '', selectedId: 0, excluded: false, scope: '', submissionKey: '' };
function storage() {
  const values = new Map();
  return { get length() { return values.size; }, key: (index) => [...values.keys()][index],
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

test('Every account, project, role and assigned site has an independent draft scope', () => {
  const key = workspaceStateKey(admin, 'Site A', 'request-draft');
  assert.notEqual(key, workspaceStateKey(admin, 'Site B', 'request-draft'));
  assert.notEqual(key, workspaceStateKey({ ...admin, user_id: 2 }, 'Site A', 'request-draft'));
  assert.notEqual(key, workspaceStateKey({ ...admin, user_type: 'project_site', project_site: 'Site A' }, 'Site A', 'request-draft'));
  assert.notEqual(workspaceOwner(admin), workspaceOwner({ ...admin, project_site: 'Site B', is_global_admin: false }));
  assert.equal(workspaceStateKey(admin, 'Site A', 'user-draft', 'account'), workspaceStateKey(admin, 'Site B', 'user-draft', 'account'));
  assert.equal(workspaceStateKey(null, 'Site A', 'request-draft'), null);
});

test('Changes save synchronously and preserve typed zeroes, blanks and exclusions on refresh', () => {
  const tab = storage();
  const key = workspaceStateKey(admin, 'Site A', 'record-draft');
  const edited = { ...initial, name: 'Cement', qty: '0', selectedId: 3, excluded: true, scope: 'Block A' };
  assert.equal(writeWorkspaceState(key, edited, initial, undefined, tab), '');
  assert.deepEqual(readWorkspaceState(key, initial, undefined, tab), { value: edited, error: '' });
  assert.deepEqual(readWorkspaceState(workspaceStateKey(admin, 'Site B', 'record-draft'), initial, undefined, tab).value, initial);
});

test('Storage schemas discard undeclared and credential fields and add new defaults', () => {
  const shape = { name: '', password: '', nested: { description: '', access_code: '' }, submissionKey: '' };
  assert.deepEqual(normalizeWorkspaceState({ name: 'Site', password: 'never persist', unexpected: 'ignored',
    nested: { description: 'Description', access_code: 'never persist', token: 'never persist' } }, shape),
  { name: 'Site', nested: { description: 'Description' }, submissionKey: '' });
  assert.throws(() => normalizeWorkspaceState({ ...initial, qty: { bad: true } }, initial));
  assert.throws(() => normalizeWorkspaceState([{}], []));
});

test('A completed action cannot erase a newer draft under the same project key', () => {
  const tab = storage();
  const key = workspaceStateKey(admin, 'Site A', 'record-draft');
  const submitted = { ...initial, name: 'Submitted', submissionKey: 'submitted-id' };
  const newer = { ...submitted, name: 'Newer work', submissionKey: '' };
  writeWorkspaceState(key, newer, initial, undefined, tab);
  assert.equal(removeWorkspaceState(key, submitted, initial, undefined, tab).cleared, false);
  assert.equal(readWorkspaceState(key, initial, undefined, tab).value.name, 'Newer work');
  assert.equal(removeWorkspaceState(key, newer, initial, undefined, tab).cleared, true);
  assert.equal(tab.getItem(key), null);
});

test('Sign-out clears only this tab’s drafts and invalidates delayed draft callbacks', () => {
  const first = storage(), second = storage();
  const key = workspaceStateKey(admin, 'Site A', 'record-draft');
  writeWorkspaceState(key, { ...initial, name: 'First tab' }, initial, undefined, first);
  writeWorkspaceState(key, { ...initial, name: 'Second tab' }, initial, undefined, second);
  first.setItem('istrom_theme', 'dark');
  const previousGeneration = workspaceGeneration();
  clearWorkspaceStates(first);
  assert.notEqual(workspaceGeneration(), previousGeneration);
  assert.equal(first.getItem(key), null);
  assert.equal(first.getItem('istrom_theme'), 'dark');
  assert.equal(readWorkspaceState(key, initial, undefined, second).value.name, 'Second tab');
});

test('Malformed data and unavailable storage report errors without breaking the form', () => {
  const tab = storage(), key = workspaceStateKey(admin, 'Site A', 'record-draft');
  tab.setItem(key, '{bad');
  assert.deepEqual(readWorkspaceState(key, initial, undefined, tab).value, initial);
  assert.ok(readWorkspaceState(key, initial, undefined, tab).error);
  const blocked = { getItem: () => { throw new Error('Blocked'); }, setItem: () => { throw new Error('Quota'); } };
  assert.ok(writeWorkspaceState(key, initial, initial, undefined, blocked));
  assert.ok(readWorkspaceState(key, initial, undefined, blocked).error);
  assert.ok(removeWorkspaceState(key, initial, initial, undefined, blocked).error);
  const value = { ...initial, qty: 'invalid' };
  writeWorkspaceState(key, value, initial, undefined, tab);
  assert.ok(readWorkspaceState(key, initial, (draft) => draft.qty === '', tab).error);
});
