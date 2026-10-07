import test from 'node:test';
import assert from 'node:assert/strict';
import { importDraftOwner, isImportDraftRecord, IMPORT_DRAFT_MAX_AGE, IMPORT_DRAFT_MAX_FILE_SIZE, readImportDraft, saveImportDraft, clearImportDraft, captureImportDraftIdentity, isCurrentImportDraftIdentity } from './importDrafts.js';

const admin = { user_id: 1, username: 'Istrom_Admin', user_type: 'admin', project_site: null, is_global_admin: true };
const TAB_KEY = 'istrom_import_draft';

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function draft(name = 'Cement') {
  return {
    projectSite: 'Site A', file: new File(['workbook contents'], 'budget.xlsx'),
    analysis: { project_site: 'Site A', file_name: 'budget.xlsx', preview_token: 'signed-preview',
      sheets: [{ sheet_name: 'Budget 1', items: [{ sheet_name: 'Sheet1', row_number: 2 }] }], layouts: [] },
    sheetMeta: { 'Budget 1': { budgetScope: 'Block A', buildingType: 'Flats', budgetNumber: 1, included: true, multiplier: 1, reviewedTotal: 100 } },
    rowEdits: { 'Sheet1::2': { name, unit: 'bags', category: 'Materials', grp: 'General Materials', section: '', qty: 1, unit_cost: 100, excluded: false } },
    columnMappings: {}, activeSheetName: 'Budget 1', reviewConfirmed: false,
  };
}

function record(workingDraft = draft(), user = admin, savedAt = 1000) {
  const metadata = { ...workingDraft };
  delete metadata.file;
  return { version: 1, owner: importDraftOwner(user), savedAt, draft: metadata };
}

function staged(projectSite = 'Site A', file = new File(['selected workbook'], 'staged.xlsx')) {
  return { stage: 'workbook', projectSite, fileName: file?.name || '', analysis: null, file };
}

function fakeDatabase() {
  const stores = new Map();
  const calls = [];
  const database = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore: (name) => stores.set(name, new Map()),
    close: () => {},
    transaction: (names, mode) => {
      const transaction = { error: null, objectStore: (name) => {
        const values = stores.get(name);
        return {
          put: (value) => { calls.push({ operation: 'put', name, id: value.id }); values.set(value.id, value); },
          delete: (id) => { calls.push({ operation: 'delete', name, id }); values.delete(id); },
          get: (id) => {
            const request = {};
            queueMicrotask(() => { request.result = values.get(id); request.onsuccess?.(); });
            return request;
          },
          openCursor: () => {
            const request = {};
            const entries = [...values.entries()];
            let index = 0;
            const advance = () => queueMicrotask(() => {
              const entry = entries[index++];
              request.result = entry ? { primaryKey: entry[0], value: entry[1], continue: advance } : null;
              request.onsuccess?.();
            });
            advance();
            return request;
          },
        };
      }, abort: () => queueMicrotask(() => transaction.onabort?.()) };
      calls.push({ operation: 'transaction', names, mode });
      setTimeout(() => transaction.oncomplete?.(), 0);
      return transaction;
    },
  };
  return {
    stores, calls, database,
    indexedDB: { open: () => {
      const request = {};
      queueMicrotask(() => {
        request.result = database;
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    } },
  };
}

test('Import draft ownership changes with account, role, site assignment and admin scope', () => {
  assert.equal(importDraftOwner({ ...admin }), importDraftOwner(admin));
  for (const change of [{ user_id: 2 }, { username: 'other.admin' }, { project_site: 'Site B' }, { project_site: 'Site A', is_global_admin: false }]) {
    assert.notEqual(importDraftOwner({ ...admin, ...change }), importDraftOwner(admin));
  }
  assert.equal(importDraftOwner({ ...admin, user_type: 'project_site' }), null);
  assert.equal(importDraftOwner(null), null);
});

test('Expired, future-dated, corrupted and wrong-account drafts cannot hydrate the preview', () => {
  const valid = record();
  assert.equal(isImportDraftRecord(valid, admin, 1000), true);
  assert.equal(isImportDraftRecord(valid, admin, 1000 + IMPORT_DRAFT_MAX_AGE), false);
  assert.equal(isImportDraftRecord(valid, admin, 999), false);
  assert.equal(isImportDraftRecord(valid, { ...admin, user_id: 2 }, 1000), false);
  for (const broken of [
    { ...valid, version: 2 }, { ...valid, savedAt: NaN },
    { ...valid, draft: { ...valid.draft, analysis: null } },
    { ...valid, draft: { ...valid.draft, rowEdits: {} } },
    { ...valid, draft: { ...valid.draft, sheetMeta: {} } },
    { ...valid, draft: { ...valid.draft, analysis: { ...valid.draft.analysis, layouts: [{}] } } },
    { ...valid, draft: { ...valid.draft, projectSite: 'Different site' } },
    { ...valid, draft: { ...valid.draft, analysis: { ...valid.draft.analysis,
      sheets: [{ ...valid.draft.analysis.sheets[0], warnings: [{ invalid: 'not text' }] }] } } },
  ]) assert.equal(isImportDraftRecord(broken, admin, 1000), false);
});

test('A scoped administrator can only restore the assigned project site', () => {
  const scoped = { ...admin, is_global_admin: false, project_site: 'Site A' };
  assert.equal(isImportDraftRecord(record(draft(), scoped), scoped, 1000), true);
  const wrongSite = { ...draft(), projectSite: 'Site B', analysis: { ...draft().analysis, project_site: 'Site B' } };
  assert.equal(isImportDraftRecord(record(wrongSite, scoped), scoped, 1000), false);
});

test('Unavailable storage reports an error instead of pretending to save', async () => {
  globalThis.sessionStorage = storage();
  globalThis.indexedDB = undefined;
  await assert.rejects(saveImportDraft(admin, draft()), /cannot save/);
  await assert.rejects(clearImportDraft(), /cannot save/);
  globalThis.sessionStorage = undefined;
  await assert.rejects(readImportDraft(admin), /cannot save/);
});

test('IndexedDB restores edits and the original workbook, then clears both after completion', async () => {
  const fake = fakeDatabase();
  globalThis.indexedDB = fake.indexedDB;
  globalThis.sessionStorage = storage();
  const working = draft('Edited cement');
  await saveImportDraft(admin, working);
  const restored = await readImportDraft(admin);
  assert.equal(restored.rowEdits['Sheet1::2'].name, 'Edited cement');
  assert.equal(restored.file.name, 'budget.xlsx');
  assert.equal(await restored.file.text(), 'workbook contents');
  await clearImportDraft();
  assert.equal(await readImportDraft(admin), null);
  assert.equal(fake.stores.get('drafts').size, 0);
  assert.equal(fake.stores.get('workbooks').size, 0);

  const first = draft('First edit');
  await saveImportDraft(admin, first);
  const workbookWrites = fake.calls.filter((call) => call.operation === 'put' && call.name === 'workbooks').length;
  await saveImportDraft(admin, { ...first, rowEdits: { ...first.rowEdits, 'Sheet1::2': { ...first.rowEdits['Sheet1::2'], name: 'Latest edit' } } });
  assert.equal(fake.calls.filter((call) => call.operation === 'put' && call.name === 'workbooks').length, workbookWrites);
  assert.equal((await readImportDraft(admin)).rowEdits['Sheet1::2'].name, 'Latest edit');
  await clearImportDraft();

  const oldSave = saveImportDraft(admin, draft('Discarded edit'));
  const oldId = globalThis.sessionStorage.getItem(TAB_KEY);
  const clearing = clearImportDraft();
  assert.equal(globalThis.sessionStorage.getItem(TAB_KEY), null);
  const newSave = saveImportDraft(admin, draft('New review'));
  const newId = globalThis.sessionStorage.getItem(TAB_KEY);
  assert.notEqual(newId, oldId);
  await Promise.all([oldSave, clearing, newSave]);
  assert.equal(fake.stores.get('drafts').has(oldId), false);
  assert.equal((await readImportDraft(admin)).rowEdits['Sheet1::2'].name, 'New review');
  await clearImportDraft();

  const firstTab = storage();
  const secondTab = storage();
  globalThis.sessionStorage = firstTab;
  await saveImportDraft(admin, draft('First tab'));
  const firstId = firstTab.getItem(TAB_KEY);
  globalThis.sessionStorage = secondTab;
  await saveImportDraft(admin, draft('Second tab'));
  assert.notEqual(firstId, secondTab.getItem(TAB_KEY));
  await clearImportDraft();
  globalThis.sessionStorage = firstTab;
  assert.equal((await readImportDraft(admin)).rowEdits['Sheet1::2'].name, 'First tab');
  assert.equal(await readImportDraft({ ...admin, user_id: 2 }), null);
  assert.equal(firstTab.getItem(TAB_KEY), null);
  assert.equal(fake.stores.get('drafts').has(firstId), false);

  globalThis.sessionStorage = storage();
  await saveImportDraft(admin, draft('Original tab'));
  const originalId = globalThis.sessionStorage.getItem(TAB_KEY);
  const copiedStorage = storage();
  copiedStorage.setItem(TAB_KEY, originalId);
  const occupiedLocks = new Set([`istrom-import:${originalId}`]);
  globalThis.navigator.locks = { request: async (name, options, callback) => {
    if (occupiedLocks.has(name)) return callback(null);
    occupiedLocks.add(name);
    try { return await callback({ name }); } finally { occupiedLocks.delete(name); }
  } };
  globalThis.sessionStorage = copiedStorage;
  assert.equal((await readImportDraft(admin)).rowEdits['Sheet1::2'].name, 'Original tab');
  const copiedId = copiedStorage.getItem(TAB_KEY);
  assert.notEqual(copiedId, originalId);
  await saveImportDraft(admin, draft('Copied tab edit'));
  assert.equal(fake.stores.get('drafts').get(originalId).draft.rowEdits['Sheet1::2'].name, 'Original tab');
  await clearImportDraft();
  assert.equal(fake.stores.get('drafts').has(copiedId), false);
  assert.equal(fake.stores.get('drafts').has(originalId), true);
  copiedStorage.setItem(TAB_KEY, originalId);
  await clearImportDraft();
  assert.equal(copiedStorage.getItem(TAB_KEY), null);
  assert.equal(fake.stores.get('drafts').has(originalId), true);
  globalThis.navigator.locks = undefined;

  fake.database.onversionchange();
  globalThis.indexedDB = { open: () => {
    const request = {};
    queueMicrotask(() => request.onblocked?.());
    return request;
  } };
  await assert.rejects(saveImportDraft(admin, draft()), /Close other app windows/);
  await assert.rejects(clearImportDraft(), /Close other app windows/);
});

test('staged workbooks validate bounded metadata, ownership and their explicit stage', () => {
  assert.equal(isImportDraftRecord(record(staged()), admin, 1000), true);
  assert.equal(isImportDraftRecord(record(staged('')), admin, 1000), true);
  assert.equal(isImportDraftRecord(record(staged('Site A', null)), admin, 1000), true);
  const scoped = { ...admin, project_site: 'Site A', is_global_admin: false };
  assert.equal(isImportDraftRecord(record(staged('Site B'), scoped), scoped, 1000), false);
  assert.equal(isImportDraftRecord(record(staged()), { ...admin, user_id: 2 }, 1000), false);
  assert.equal(isImportDraftRecord(record(staged()), admin, 1000 + IMPORT_DRAFT_MAX_AGE), false);
  for (const broken of [
    { ...staged(), stage: 'unexpected' }, { ...staged(), analysis: {} },
    { ...staged(), rowEdits: {} }, { ...staged(), fileName: 'a'.repeat(256) },
    { ...staged(), fileName: 'bad\u0000name.xlsx' }, { ...staged(), projectSite: [] },
    { ...staged(), projectSite: 'a'.repeat(256) }, { ...staged(), fileName: null },
    staged('', null),
  ]) assert.equal(isImportDraftRecord(record(broken), admin, 1000), false);
});

test('staged selection restores file bytes and site before analysis, then clears replacement files safely', async () => {
  const fake = fakeDatabase();
  globalThis.indexedDB = fake.indexedDB;
  globalThis.sessionStorage = storage();
  const selected = staged();
  await saveImportDraft(admin, selected);
  const first = await readImportDraft(admin);
  assert.equal(first.stage, 'workbook');
  assert.equal(first.analysis, null);
  assert.equal(first.projectSite, 'Site A');
  assert.equal(first.file.name, 'staged.xlsx');
  assert.equal(await first.file.text(), 'selected workbook');
  const workbookWrites = fake.calls.filter((call) => call.operation === 'put' && call.name === 'workbooks').length;
  await saveImportDraft(admin, { ...selected, projectSite: 'Site B' });
  assert.equal((await readImportDraft(admin)).projectSite, 'Site B');
  assert.equal(fake.calls.filter((call) => call.operation === 'put' && call.name === 'workbooks').length, workbookWrites);
  await saveImportDraft(admin, staged('Site B', null));
  const clearedFile = await readImportDraft(admin);
  assert.equal(clearedFile.file, null);
  assert.equal(clearedFile.fileName, '');
  assert.equal(clearedFile.projectSite, 'Site B');
  assert.equal(fake.stores.get('workbooks').size, 0);

  const replacement = staged('Site B', new File(['replacement workbook'], 'replacement.xlsx'));
  await saveImportDraft(admin, replacement);
  const id = globalThis.sessionStorage.getItem(TAB_KEY);
  fake.stores.get('workbooks').delete(id);
  const missing = await readImportDraft(admin);
  assert.equal(missing.file, null);
  assert.equal(missing.fileName, 'replacement.xlsx');
  assert.equal(missing.analysis, null);
  await clearImportDraft();
  assert.equal(await readImportDraft(admin), null);
  fake.database.onversionchange();
});

test('workbook size and selected filename are checked before saving staged or preview files', async () => {
  const fake = fakeDatabase();
  globalThis.indexedDB = fake.indexedDB;
  globalThis.sessionStorage = storage();
  const limitFile = new File([new Uint8Array(IMPORT_DRAFT_MAX_FILE_SIZE)], 'limit.xlsx');
  await saveImportDraft(admin, staged('Site A', limitFile));
  assert.equal((await readImportDraft(admin)).file.size, IMPORT_DRAFT_MAX_FILE_SIZE);
  const oversized = new File([limitFile, 'x'], 'oversized.xlsx');
  await assert.rejects(saveImportDraft(admin, staged('Site A', oversized)), /15 MB/);
  await assert.rejects(saveImportDraft(admin, { ...draft(), file: oversized }), /15 MB/);
  await assert.rejects(saveImportDraft(admin, { ...staged(), fileName: 'another.xlsx' }), /name does not match/);
  assert.equal((await readImportDraft(admin)).file.name, 'limit.xlsx');
  await clearImportDraft();
  fake.database.onversionchange();
});

test('an old import cleanup cannot erase a new staged workbook or restore a discarded file', async () => {
  const fake = fakeDatabase();
  globalThis.indexedDB = fake.indexedDB;
  globalThis.sessionStorage = storage();
  await saveImportDraft(admin, staged());
  const oldIdentity = captureImportDraftIdentity();
  assert.equal(isCurrentImportDraftIdentity(oldIdentity), true);
  const clearing = clearImportDraft();
  const saving = saveImportDraft(admin, staged('Site B', new File(['new selected file'], 'new.xlsx')));
  await Promise.all([clearing, saving]);
  assert.equal(isCurrentImportDraftIdentity(oldIdentity), false);
  assert.equal(await clearImportDraft(oldIdentity), false);
  const restored = await readImportDraft(admin);
  assert.equal(restored.file.name, 'new.xlsx');
  assert.equal(await restored.file.text(), 'new selected file');
  assert.equal(restored.projectSite, 'Site B');
  await clearImportDraft(captureImportDraftIdentity());
  assert.equal(await readImportDraft(admin), null);
  const obsolete = saveImportDraft(admin, staged());
  const discarding = clearImportDraft();
  await Promise.all([obsolete, discarding]);
  assert.equal(await readImportDraft(admin), null);
  assert.equal(fake.stores.get('workbooks').size, 0);
  fake.database.onversionchange();
});
