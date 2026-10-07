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

function clearSourceAfterDraftRead(fake, clearSource) {
  const transact = fake.database.transaction;
  let delayed = false;
  fake.database.transaction = (names, mode) => {
    const transaction = transact(names, mode);
    if (mode !== 'readonly' || delayed) return transaction;
    delayed = true;
    let complete;
    Object.defineProperty(transaction, 'oncomplete', {
      get: () => () => {
        // Finish a real source clear before delivering the copied tab's read.
        Promise.resolve().then(clearSource).then(() => complete?.(), (error) => {
          transaction.error = error;
          transaction.onabort?.();
        });
      },
      set: (callback) => { complete = callback; },
    });
    return transaction;
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
  fake.stores.get('workbooks').delete(fake.stores.get('drafts').get(id).workbookId || id);
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

test('Without Web Locks, copied and refreshed tabs isolate drafts while sharing workbook bytes', async () => {
  const first = await import('./importDrafts.js?fallback-first');
  const copied = await import('./importDrafts.js?fallback-copied');
  const early = await import('./importDrafts.js?fallback-early-clear');
  const wrongOwner = await import('./importDrafts.js?fallback-wrong-owner');
  const refreshed = await import('./importDrafts.js?fallback-refreshed');
  const fake = fakeDatabase();
  globalThis.indexedDB = fake.indexedDB;
  globalThis.navigator.locks = undefined;
  const originalStorage = storage();
  globalThis.sessionStorage = originalStorage;
  await first.saveImportDraft(admin, draft('Original edit'));
  const originalId = originalStorage.getItem(TAB_KEY);

  const earlyStorage = storage();
  earlyStorage.setItem(TAB_KEY, originalId);
  globalThis.sessionStorage = earlyStorage;
  await early.clearImportDraft();
  assert.equal(earlyStorage.getItem(TAB_KEY), null);
  assert.equal(fake.stores.get('drafts').has(originalId), true);

  const wrongStorage = storage();
  wrongStorage.setItem(TAB_KEY, originalId);
  globalThis.sessionStorage = wrongStorage;
  assert.equal(await wrongOwner.readImportDraft({ ...admin, user_id: 2 }), null);
  assert.equal(wrongStorage.getItem(TAB_KEY), null);
  assert.equal(fake.stores.get('drafts').has(originalId), true);

  const copiedStorage = storage();
  copiedStorage.setItem(TAB_KEY, originalId);
  globalThis.sessionStorage = copiedStorage;
  const working = await copied.readImportDraft(admin);
  const copiedId = copiedStorage.getItem(TAB_KEY);
  assert.notEqual(copiedId, originalId);
  working.rowEdits = { ...working.rowEdits,
    'Sheet1::2': { ...working.rowEdits['Sheet1::2'], name: 'Copied edit' } };
  await copied.saveImportDraft(admin, working);
  assert.equal(fake.stores.get('drafts').get(originalId).draft.rowEdits['Sheet1::2'].name, 'Original edit');
  assert.equal(fake.stores.get('workbooks').size, 1);

  const afterRefresh = await refreshed.readImportDraft(admin);
  const refreshedId = copiedStorage.getItem(TAB_KEY);
  assert.notEqual(refreshedId, copiedId);
  assert.equal(afterRefresh.rowEdits['Sheet1::2'].name, 'Copied edit');
  assert.equal(await afterRefresh.file.text(), 'workbook contents');
  assert.equal(fake.stores.get('workbooks').size, 1);

  globalThis.sessionStorage = originalStorage;
  await first.clearImportDraft();
  assert.equal(fake.stores.get('drafts').has(originalId), false);
  assert.equal(fake.stores.get('workbooks').size, 1);
  globalThis.sessionStorage = copiedStorage;
  assert.equal((await refreshed.readImportDraft(admin)).rowEdits['Sheet1::2'].name, 'Copied edit');
  await refreshed.clearImportDraft();
  // The refresh source remains a recovery snapshot until its own clear or expiry.
  assert.equal(fake.stores.get('drafts').has(copiedId), true);
  copiedStorage.setItem(TAB_KEY, copiedId);
  await copied.clearImportDraft();
  assert.equal(fake.stores.get('drafts').size, 0);
  assert.equal(fake.stores.get('workbooks').size, 0);
  fake.database.onversionchange();
});

test('Replacing a copied workbook preserves other tabs and prunes only unreferenced bytes', async () => {
  const first = await import('./importDrafts.js?fallback-file-first');
  const copied = await import('./importDrafts.js?fallback-file-copied');
  const fake = fakeDatabase();
  globalThis.indexedDB = fake.indexedDB;
  globalThis.navigator.locks = undefined;
  const originalStorage = storage();
  const copiedStorage = storage();
  globalThis.sessionStorage = originalStorage;
  await first.saveImportDraft(admin, staged());
  copiedStorage.setItem(TAB_KEY, originalStorage.getItem(TAB_KEY));
  globalThis.sessionStorage = copiedStorage;
  await copied.readImportDraft(admin);
  await copied.saveImportDraft(admin, staged('Site A', new File(['new workbook'], 'new.xlsx')));
  assert.equal(fake.stores.get('workbooks').size, 2);
  globalThis.sessionStorage = originalStorage;
  assert.equal(await (await first.readImportDraft(admin)).file.text(), 'selected workbook');
  globalThis.sessionStorage = copiedStorage;
  assert.equal(await (await copied.readImportDraft(admin)).file.text(), 'new workbook');
  await copied.clearImportDraft();
  assert.equal(fake.stores.get('workbooks').size, 1);
  globalThis.sessionStorage = originalStorage;
  await first.clearImportDraft();
  assert.equal(fake.stores.get('workbooks').size, 0);
  fake.database.onversionchange();
});

test('A failed copied-tab transaction leaves the inherited draft pointer recoverable', async () => {
  const first = await import('./importDrafts.js?copy-quota-first');
  const copied = await import('./importDrafts.js?copy-quota-copied');
  const fake = fakeDatabase();
  globalThis.indexedDB = fake.indexedDB;
  globalThis.navigator.locks = undefined;
  const originalStorage = storage();
  const copiedStorage = storage();
  globalThis.sessionStorage = originalStorage;
  await first.saveImportDraft(admin, draft('Recoverable edit'));
  const originalId = originalStorage.getItem(TAB_KEY);
  copiedStorage.setItem(TAB_KEY, originalId);
  globalThis.sessionStorage = copiedStorage;
  const transact = fake.database.transaction;
  let failCopy = true;
  fake.database.transaction = (names, mode) => {
    const transaction = transact(names, mode);
    const store = transaction.objectStore;
    transaction.objectStore = (name) => {
      const objectStore = store(name);
      const put = objectStore.put;
      objectStore.put = (value) => {
        if (name !== 'drafts' || value.id === originalId || !failCopy) return put(value);
        failCopy = false;
        transaction.error = new DOMException('Storage quota exceeded', 'QuotaExceededError');
        queueMicrotask(() => transaction.onabort?.());
      };
      return objectStore;
    };
    return transaction;
  };
  await assert.rejects(copied.readImportDraft(admin), /Storage quota exceeded/);
  assert.equal(copiedStorage.getItem(TAB_KEY), originalId);
  assert.equal(fake.stores.get('drafts').get(originalId).draft.rowEdits['Sheet1::2'].name, 'Recoverable edit');
  assert.equal(fake.stores.get('workbooks').size, 1);
  const recovered = await copied.readImportDraft(admin);
  assert.notEqual(copiedStorage.getItem(TAB_KEY), originalId);
  assert.equal(recovered.rowEdits['Sheet1::2'].name, 'Recoverable edit');
  assert.equal(await recovered.file.text(), 'workbook contents');
  await copied.clearImportDraft();
  globalThis.sessionStorage = originalStorage;
  await first.clearImportDraft();
  fake.database.onversionchange();
});

test('Expired recovery metadata does not delete workbook bytes referenced by an active tab', async () => {
  const first = await import('./importDrafts.js?expiry-first');
  const copied = await import('./importDrafts.js?expiry-copied');
  const refreshed = await import('./importDrafts.js?expiry-refreshed');
  const fake = fakeDatabase();
  globalThis.indexedDB = fake.indexedDB;
  globalThis.navigator.locks = undefined;
  const originalStorage = storage();
  const copiedStorage = storage();
  globalThis.sessionStorage = originalStorage;
  await first.saveImportDraft(admin, draft());
  const originalId = originalStorage.getItem(TAB_KEY);
  copiedStorage.setItem(TAB_KEY, originalId);
  globalThis.sessionStorage = copiedStorage;
  await copied.readImportDraft(admin);
  const copiedId = copiedStorage.getItem(TAB_KEY);
  fake.stores.get('drafts').get(originalId).savedAt = Date.now() - IMPORT_DRAFT_MAX_AGE - 1;
  const restored = await refreshed.readImportDraft(admin);
  assert.equal(fake.stores.get('drafts').has(originalId), false);
  assert.equal(fake.stores.get('workbooks').size, 1);
  assert.equal(await restored.file.text(), 'workbook contents');
  await refreshed.clearImportDraft();
  copiedStorage.setItem(TAB_KEY, copiedId);
  await copied.clearImportDraft();
  assert.equal(fake.stores.get('workbooks').size, 0);
  fake.database.onversionchange();
});

test('A concurrent source-tab clear after reading cannot leave the copied workbook reference missing', async () => {
  const first = await import('./importDrafts.js?clear-race-first');
  const copied = await import('./importDrafts.js?clear-race-copied');
  const fake = fakeDatabase();
  globalThis.indexedDB = fake.indexedDB;
  globalThis.navigator.locks = undefined;
  const originalStorage = storage();
  globalThis.sessionStorage = originalStorage;
  await first.saveImportDraft(admin, draft());
  const originalId = globalThis.sessionStorage.getItem(TAB_KEY);
  const copiedStorage = storage();
  copiedStorage.setItem(TAB_KEY, originalId);
  globalThis.sessionStorage = copiedStorage;
  clearSourceAfterDraftRead(fake, () => {
    globalThis.sessionStorage = originalStorage;
    const clearing = first.clearImportDraft();
    globalThis.sessionStorage = copiedStorage;
    return clearing;
  });
  const restored = await copied.readImportDraft(admin);
  assert.equal(fake.stores.get('drafts').has(originalId), false);
  assert.equal(await restored.file.text(), 'workbook contents');
  assert.equal(fake.stores.get('workbooks').size, 1);
  assert.equal(await (await copied.readImportDraft(admin)).file.text(), 'workbook contents');
  await copied.clearImportDraft();
  assert.equal(fake.stores.get('workbooks').size, 0);
  fake.database.onversionchange();
});

test('A shared workbook reference is read atomically before its last source tab clears', async () => {
  const first = await import('./importDrafts.js?reference-race-first');
  const copied = await import('./importDrafts.js?reference-race-copied');
  const refreshed = await import('./importDrafts.js?reference-race-refreshed');
  const fake = fakeDatabase();
  globalThis.indexedDB = fake.indexedDB;
  globalThis.navigator.locks = undefined;
  const originalStorage = storage();
  const copiedStorage = storage();
  const refreshedStorage = storage();
  globalThis.sessionStorage = originalStorage;
  await first.saveImportDraft(admin, draft('Shared edit'));
  const originalId = originalStorage.getItem(TAB_KEY);
  copiedStorage.setItem(TAB_KEY, originalId);
  globalThis.sessionStorage = copiedStorage;
  await copied.readImportDraft(admin);
  const copiedId = copiedStorage.getItem(TAB_KEY);
  assert.equal(fake.stores.get('drafts').get(copiedId).workbookId, originalId);
  globalThis.sessionStorage = originalStorage;
  await first.clearImportDraft();
  refreshedStorage.setItem(TAB_KEY, copiedId);
  globalThis.sessionStorage = refreshedStorage;
  clearSourceAfterDraftRead(fake, () => {
    globalThis.sessionStorage = copiedStorage;
    const clearing = copied.clearImportDraft();
    globalThis.sessionStorage = refreshedStorage;
    return clearing;
  });
  const readsBefore = fake.calls.filter((call) => call.operation === 'transaction' && call.mode === 'readonly').length;
  const restored = await refreshed.readImportDraft(admin);
  const readsAfter = fake.calls.filter((call) => call.operation === 'transaction' && call.mode === 'readonly').length;
  assert.equal(readsAfter - readsBefore, 1);
  assert.equal(fake.stores.get('drafts').has(copiedId), false);
  assert.equal(restored.rowEdits['Sheet1::2'].name, 'Shared edit');
  assert.equal(await restored.file.text(), 'workbook contents');
  assert.equal(await (await refreshed.readImportDraft(admin)).file.text(), 'workbook contents');
  await refreshed.clearImportDraft();
  assert.equal(fake.stores.get('workbooks').size, 0);
  fake.database.onversionchange();
});

test('A copied tab saving before hydration preserves its inherited pointer if storage is full', async () => {
  const first = await import('./importDrafts.js?save-quota-first');
  const copied = await import('./importDrafts.js?save-quota-copied');
  const fake = fakeDatabase();
  globalThis.indexedDB = fake.indexedDB;
  globalThis.navigator.locks = undefined;
  const originalStorage = storage();
  const copiedStorage = storage();
  globalThis.sessionStorage = originalStorage;
  await first.saveImportDraft(admin, draft('Original recoverable edit'));
  const originalId = originalStorage.getItem(TAB_KEY);
  copiedStorage.setItem(TAB_KEY, originalId);
  globalThis.sessionStorage = copiedStorage;
  const transact = fake.database.transaction;
  let failSave = true;
  fake.database.transaction = (names, mode) => {
    const transaction = transact(names, mode);
    const store = transaction.objectStore;
    transaction.objectStore = (name) => {
      const objectStore = store(name);
      const put = objectStore.put;
      objectStore.put = (value) => {
        if (name !== 'drafts' || value.id === originalId || !failSave) return put(value);
        failSave = false;
        transaction.error = new DOMException('Storage quota exceeded', 'QuotaExceededError');
        queueMicrotask(() => transaction.onabort?.());
      };
      return objectStore;
    };
    return transaction;
  };
  await assert.rejects(copied.saveImportDraft(admin, draft('Unsaved edit')), /Storage quota exceeded/);
  assert.equal(copiedStorage.getItem(TAB_KEY), originalId);
  assert.equal(fake.stores.get('drafts').get(originalId).draft.rowEdits['Sheet1::2'].name, 'Original recoverable edit');
  assert.equal(fake.stores.get('workbooks').size, 1);
  const restored = await copied.readImportDraft(admin);
  assert.equal(restored.rowEdits['Sheet1::2'].name, 'Original recoverable edit');
  assert.equal(await restored.file.text(), 'workbook contents');
  await copied.clearImportDraft();
  globalThis.sessionStorage = originalStorage;
  await first.clearImportDraft();
  fake.database.onversionchange();
});

test('Queued saves follow a successful copied-tab fork without dropping the latest edit', async () => {
  const first = await import('./importDrafts.js?queued-save-first');
  const copied = await import('./importDrafts.js?queued-save-copied');
  const fake = fakeDatabase();
  globalThis.indexedDB = fake.indexedDB;
  globalThis.navigator.locks = undefined;
  const originalStorage = storage();
  const copiedStorage = storage();
  globalThis.sessionStorage = originalStorage;
  await first.saveImportDraft(admin, draft('Original edit'));
  const originalId = originalStorage.getItem(TAB_KEY);
  copiedStorage.setItem(TAB_KEY, originalId);
  globalThis.sessionStorage = copiedStorage;
  const earlier = draft('Earlier copied edit');
  const latest = { ...earlier, rowEdits: { ...earlier.rowEdits,
    'Sheet1::2': { ...earlier.rowEdits['Sheet1::2'], name: 'Latest copied edit' } } };
  const saving = [copied.saveImportDraft(admin, earlier), copied.saveImportDraft(admin, latest)];
  assert.equal(copiedStorage.getItem(TAB_KEY), originalId);
  assert.deepEqual(await Promise.all(saving), [true, true]);
  const copiedId = copiedStorage.getItem(TAB_KEY);
  assert.notEqual(copiedId, originalId);
  assert.equal(fake.stores.get('drafts').get(copiedId).draft.rowEdits['Sheet1::2'].name, 'Latest copied edit');
  assert.equal(fake.stores.get('drafts').get(originalId).draft.rowEdits['Sheet1::2'].name, 'Original edit');
  await copied.clearImportDraft();
  globalThis.sessionStorage = originalStorage;
  await first.clearImportDraft();
  fake.database.onversionchange();
});

test('Web Locks reuse the draft ID on refresh and fork only an occupied copied tab', async () => {
  const first = await import('./importDrafts.js?locked-first');
  const copied = await import('./importDrafts.js?locked-copied');
  const refreshed = await import('./importDrafts.js?locked-refreshed');
  const fake = fakeDatabase();
  globalThis.indexedDB = fake.indexedDB;
  const locks = new Map();
  globalThis.navigator.locks = { request: (name, options, callback) => {
    if (locks.has(name)) return Promise.resolve(callback(null));
    let release;
    const stopped = new Promise((resolve) => { release = resolve; });
    locks.set(name, release);
    return Promise.race([Promise.resolve(callback({ name })), stopped]).finally(() => { locks.delete(name); });
  } };
  const originalStorage = storage();
  const copiedStorage = storage();
  globalThis.sessionStorage = originalStorage;
  await first.saveImportDraft(admin, draft('Locked edit'));
  const originalId = originalStorage.getItem(TAB_KEY);
  copiedStorage.setItem(TAB_KEY, originalId);
  globalThis.sessionStorage = copiedStorage;
  await copied.readImportDraft(admin);
  assert.notEqual(copiedStorage.getItem(TAB_KEY), originalId);
  assert.equal(fake.stores.get('workbooks').size, 1);
  await copied.clearImportDraft();

  // Closing the old document releases its native lock before refresh hydration.
  locks.get(`istrom-import:${originalId}`)?.();
  await Promise.resolve();
  await Promise.resolve();
  globalThis.sessionStorage = originalStorage;
  const restored = await refreshed.readImportDraft(admin);
  assert.equal(originalStorage.getItem(TAB_KEY), originalId);
  assert.equal(restored.rowEdits['Sheet1::2'].name, 'Locked edit');
  await refreshed.clearImportDraft();
  globalThis.navigator.locks = undefined;
  fake.database.onversionchange();
});
