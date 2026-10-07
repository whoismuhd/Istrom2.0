import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectSelection, saveProjectSelection, validateProjectSelection } from './workspace.js';

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

const admin = { user_id: 1, user_type: 'admin', is_global_admin: true, project_site: null };

test('Refreshing restores the selected project and choosing All Sites replaces it', () => {
  const tab = storage();
  saveProjectSelection(admin, 'Site A', tab);
  assert.equal(readProjectSelection({ ...admin }, tab), 'Site A');
  saveProjectSelection(admin, null, tab);
  assert.equal(readProjectSelection({ ...admin }, tab), null);
});

test('Separate browser tabs and accounts retain their own project selection', () => {
  const firstTab = storage();
  const secondTab = storage();
  saveProjectSelection(admin, 'Site A', firstTab);
  saveProjectSelection(admin, 'Site B', secondTab);
  saveProjectSelection({ ...admin, user_id: 2 }, 'Site C', firstTab);
  assert.equal(readProjectSelection(admin, firstTab), 'Site A');
  assert.equal(readProjectSelection(admin, secondTab), 'Site B');
  assert.equal(readProjectSelection({ ...admin, user_id: 2 }, firstTab), 'Site C');
});

test('Stored admin selections cannot override assigned site-user or scoped-admin access', () => {
  const tab = storage();
  saveProjectSelection(admin, 'Site A', tab);
  for (const user_type of ['project_site', 'admin']) {
    const assignedUser = { ...admin, user_type, is_global_admin: false, project_site: 'Site B' };
    assert.equal(readProjectSelection(assignedUser, tab), 'Site B');
    assert.equal(saveProjectSelection(assignedUser, 'Site C', tab), 'Site B');
    assert.equal(validateProjectSelection(assignedUser, [], tab), 'Site B');
  }
  assert.equal(readProjectSelection(admin, tab), 'Site A');
});

test('A renamed or deactivated project is cleared only after checking active sites', () => {
  const tab = storage();
  saveProjectSelection(admin, 'Site A', tab);
  assert.equal(validateProjectSelection(admin, [{ name: 'Site A' }], tab), 'Site A');
  assert.equal(validateProjectSelection(admin, [{ name: 'Site B' }], tab), null);
  assert.equal(readProjectSelection(admin, tab), null);
});

test('Blocked browser storage does not prevent selecting a project', () => {
  const blocked = {
    getItem: () => { throw new Error('Blocked'); },
    setItem: () => { throw new Error('Blocked'); },
    removeItem: () => { throw new Error('Blocked'); },
  };
  assert.equal(readProjectSelection(admin, blocked), null);
  assert.equal(saveProjectSelection(admin, 'Site A', blocked), 'Site A');
  assert.equal(saveProjectSelection(admin, null, blocked), null);
});
