const DATABASE_NAME = 'istrom-import-drafts';
const DATABASE_VERSION = 1;
const DRAFT_STORE = 'drafts';
const WORKBOOK_STORE = 'workbooks';
const TAB_KEY = 'istrom_import_draft';
const RECORD_VERSION = 1;
export const IMPORT_DRAFT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
export const IMPORT_DRAFT_MAX_FILE_SIZE = 15 * 1024 * 1024;

let databasePromise;
let operationQueue = Promise.resolve();
let generation = 0;
const savedFiles = new Map();
const heldLocks = new Map();
const isObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const isNumericInput = (value) => value == null || typeof value === 'string' || typeof value === 'number';
const isTextList = (value) => value == null || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
const isFileName = (value) => typeof value === 'string' && value.length <= 255
  && Array.from(value).every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
const isWorkbookFile = (file) => file instanceof Blob && file.size <= IMPORT_DRAFT_MAX_FILE_SIZE
  && isFileName(file.name) && file.name.length > 0;

export function importDraftOwner(user) {
  if (user?.user_type !== 'admin' || !user.username) return null;
  return JSON.stringify([
    user.user_id ?? null, user.username, user.user_type,
    user.project_site || null,
    user.is_global_admin === true || !user.project_site,
  ]);
}

function validDraft(draft, user) {
  if (isObject(draft) && draft.stage === 'workbook') {
    return Object.keys(draft).every((key) => ['stage', 'projectSite', 'fileName', 'analysis', 'file'].includes(key))
      && typeof draft.projectSite === 'string' && draft.projectSite.length <= 255
      && (!user.project_site || user.is_global_admin === true || !draft.projectSite || draft.projectSite === user.project_site)
      && isFileName(draft.fileName) && Boolean(draft.fileName || draft.projectSite)
      && draft.analysis === null;
  }
  if (draft?.stage != null && draft.stage !== 'preview') return false;
  if (!(isObject(draft)
    && typeof draft.projectSite === 'string' && draft.projectSite.length > 0 && draft.projectSite.length <= 255
    && (!user.project_site || user.is_global_admin === true || draft.projectSite === user.project_site)
    && isObject(draft.analysis) && draft.analysis.project_site === draft.projectSite
    && typeof draft.analysis.preview_token === 'string'
    && typeof draft.analysis.file_name === 'string'
    && Array.isArray(draft.analysis.sheets) && Array.isArray(draft.analysis.layouts)
    && isObject(draft.sheetMeta) && isObject(draft.rowEdits) && isObject(draft.columnMappings))) return false;
  for (const sheet of draft.analysis.sheets) {
    const meta = draft.sheetMeta[sheet?.sheet_name];
    if (!isObject(sheet) || typeof sheet.sheet_name !== 'string' || !Array.isArray(sheet.items)
      || !isObject(meta) || typeof meta.budgetScope !== 'string' || typeof meta.buildingType !== 'string'
      || !isTextList(sheet.warnings)
      || typeof meta.included !== 'boolean' || !isNumericInput(meta.multiplier)
      || !isNumericInput(meta.budgetNumber) || !isNumericInput(meta.reviewedTotal)) return false;
    for (const item of sheet.items) {
      const edit = draft.rowEdits[`${item?.sheet_name}::${item?.row_number}`];
      if (!isObject(item) || typeof item.sheet_name !== 'string' || !Number.isInteger(item.row_number)
        || !isTextList(item.warnings) || !isTextList(item.errors)
        || !isObject(edit) || !['name', 'unit', 'category', 'grp', 'section'].every((field) => typeof edit[field] === 'string')
        || !isNumericInput(edit.qty) || !isNumericInput(edit.unit_cost) || typeof edit.excluded !== 'boolean') return false;
    }
  }
  return draft.analysis.layouts.every((layout) => isObject(layout) && typeof layout.sheet_name === 'string'
    && Array.isArray(layout.columns) && Array.isArray(layout.sample_rows)
    && Array.isArray(layout.warnings) && isTextList(layout.warnings)
    && isObject(layout.suggested_mapping)
    && isObject(draft.columnMappings[layout.sheet_name]) && isObject(draft.columnMappings[layout.sheet_name].columns)
    && layout.columns.every((column) => isObject(column) && typeof column.label === 'string')
    && layout.sample_rows.every((row) => isObject(row) && Array.isArray(row.cells)));
}

export function isImportDraftRecord(record, user, now = Date.now()) {
  const owner = importDraftOwner(user);
  return Boolean(owner && record?.version === RECORD_VERSION && record.owner === owner
    && Number.isFinite(record.savedAt) && record.savedAt <= now
    && now - record.savedAt < IMPORT_DRAFT_MAX_AGE && validDraft(record.draft, user));
}

function tabStorage() {
  const storage = globalThis.sessionStorage;
  if (!storage) throw new Error('This browser cannot save the import preview.');
  return storage;
}

export function captureImportDraftIdentity() {
  try { return { id: tabStorage().getItem(TAB_KEY), generation }; }
  catch { return null; }
}

export function isCurrentImportDraftIdentity(identity) {
  try { return Boolean(identity && identity.generation === generation && identity.id === tabStorage().getItem(TAB_KEY)); }
  catch { return false; }
}

function newKey() {
  if (!globalThis.crypto?.randomUUID) throw new Error('This browser cannot save the import preview.');
  return `draft-${globalThis.crypto.randomUUID()}`;
}

function queue(operation) {
  const result = operationQueue.then(operation);
  operationQueue = result.catch(() => {});
  return result;
}

async function holdDraftLock(id) {
  if (!globalThis.navigator?.locks?.request || heldLocks.has(id)) return true;
  return new Promise((resolve, reject) => {
    globalThis.navigator.locks.request(`istrom-import:${id}`, { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(false); return; }
      let release;
      const held = new Promise((finish) => { release = finish; });
      heldLocks.set(id, release);
      resolve(true);
      return held.finally(() => { heldLocks.delete(id); });
    }).catch(reject);
  });
}

async function claimTabRecord(storage, originalId, operationGeneration) {
  if (await holdDraftLock(originalId)) return { id: originalId, sourceId: originalId };
  // Duplicate Tab copies sessionStorage. Fork its draft instead of sharing edits.
  const id = newKey();
  await holdDraftLock(id);
  if (generation !== operationGeneration || storage.getItem(TAB_KEY) !== originalId) {
    heldLocks.get(id)?.();
    return null;
  }
  storage.setItem(TAB_KEY, id);
  return { id, sourceId: originalId };
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { transaction.abort(); } catch { /* The browser may have closed it already. */ }
      reject(new Error('Import preview storage did not respond.'));
    }, 15000);
    transaction.oncomplete = () => { clearTimeout(timer); resolve(); };
    transaction.onabort = () => { clearTimeout(timer); reject(transaction.error || new Error('Could not save the import preview.')); };
    transaction.onerror = () => { /* The transaction abort reports the failure. */ };
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not read the import preview.'));
  });
}

async function removeExpired(database) {
  const transaction = database.transaction([DRAFT_STORE, WORKBOOK_STORE], 'readwrite');
  const done = transactionDone(transaction);
  const drafts = transaction.objectStore(DRAFT_STORE);
  const workbooks = transaction.objectStore(WORKBOOK_STORE);
  const request = drafts.openCursor();
  const cutoff = Date.now() - IMPORT_DRAFT_MAX_AGE;
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    if (!Number.isFinite(cursor.value.savedAt) || cursor.value.savedAt <= cutoff) {
      drafts.delete(cursor.primaryKey);
      workbooks.delete(cursor.primaryKey);
      savedFiles.delete(cursor.primaryKey);
    }
    cursor.continue();
  };
  await done;
}

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error('This browser cannot save the import preview.'));
        return;
      }
      const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      let blocked = false;
      const timer = setTimeout(() => {
        blocked = true;
        reject(new Error('Import preview storage did not respond.'));
      }, 15000);
      request.onupgradeneeded = () => {
        const database = request.result;
        for (const name of [DRAFT_STORE, WORKBOOK_STORE]) {
          if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, { keyPath: 'id' });
        }
      };
      request.onblocked = () => {
        blocked = true;
        clearTimeout(timer);
        reject(new Error('Close other app windows to enable import preview saving.'));
      };
      request.onerror = () => { clearTimeout(timer); reject(request.error || new Error('Could not open import preview storage.')); };
      request.onsuccess = async () => {
        clearTimeout(timer);
        const database = request.result;
        if (blocked) {
          database.close();
          return;
        }
        database.onversionchange = () => { database.close(); databasePromise = undefined; };
        try {
          await removeExpired(database);
          resolve(database);
        } catch (error) {
          database.close();
          reject(error);
        }
      };
    }).catch((error) => { databasePromise = undefined; throw error; });
  }
  return databasePromise;
}

async function deleteRecord(id) {
  try {
    const database = await openDatabase();
    const transaction = database.transaction([DRAFT_STORE, WORKBOOK_STORE], 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore(DRAFT_STORE).delete(id);
    transaction.objectStore(WORKBOOK_STORE).delete(id);
    await done;
  } finally {
    savedFiles.delete(id);
    heldLocks.get(id)?.();
  }
}

export async function readImportDraft(user) {
  const storage = tabStorage();
  const id = storage.getItem(TAB_KEY);
  if (!id) return null;
  if (!importDraftOwner(user)) {
    await clearImportDraft();
    return null;
  }
  const readingGeneration = generation;
  return queue(async () => {
    if (readingGeneration !== generation || storage.getItem(TAB_KEY) !== id) return null;
    const claim = await claimTabRecord(storage, id, readingGeneration);
    if (!claim || readingGeneration !== generation || storage.getItem(TAB_KEY) !== claim.id) return null;
    const database = await openDatabase();
    const transaction = database.transaction([DRAFT_STORE, WORKBOOK_STORE], 'readonly');
    const done = transactionDone(transaction);
    const [, record, workbook] = await Promise.all([
      done,
      requestResult(transaction.objectStore(DRAFT_STORE).get(claim.sourceId)),
      requestResult(transaction.objectStore(WORKBOOK_STORE).get(claim.sourceId)),
    ]);
    if (readingGeneration !== generation || storage.getItem(TAB_KEY) !== claim.id) return null;
    if (!isImportDraftRecord(record, user)) {
      storage.removeItem(TAB_KEY);
      generation += 1;
      await deleteRecord(claim.id);
      return null;
    }
    const savedFile = workbook?.file;
    const file = isWorkbookFile(savedFile)
      && (record.draft.stage !== 'workbook' || savedFile.name === record.draft.fileName) ? savedFile : null;
    if (claim.id !== claim.sourceId) {
      const copying = database.transaction([DRAFT_STORE, WORKBOOK_STORE], 'readwrite');
      const copied = transactionDone(copying);
      copying.objectStore(DRAFT_STORE).put({ ...record, id: claim.id });
      if (file) copying.objectStore(WORKBOOK_STORE).put({ id: claim.id, file });
      await copied;
    }
    if (readingGeneration !== generation || storage.getItem(TAB_KEY) !== claim.id) return null;
    savedFiles.set(claim.id, file);
    return { ...record.draft, file };
  });
}

export async function saveImportDraft(user, draft) {
  const owner = importDraftOwner(user);
  if (!owner || !validDraft(draft, user)) throw new Error('The import preview does not match this account or project site.');
  if (draft.file != null && !isWorkbookFile(draft.file)) throw new Error('Choose a workbook no larger than 15 MB.');
  if (draft.stage === 'workbook' && draft.file && draft.file.name !== draft.fileName) throw new Error('The saved workbook name does not match the selected file.');
  const storage = tabStorage();
  let id = storage.getItem(TAB_KEY);
  if (!id) {
    id = newKey();
    storage.setItem(TAB_KEY, id);
  }
  const writingGeneration = generation;
  const { file = null, ...metadata } = draft;
  return queue(async () => {
    if (writingGeneration !== generation || storage.getItem(TAB_KEY) !== id) return false;
    const claim = await claimTabRecord(storage, id, writingGeneration);
    if (!claim) return false;
    id = claim.id;
    const database = await openDatabase();
    if (writingGeneration !== generation || storage.getItem(TAB_KEY) !== id) return false;
    const transaction = database.transaction([DRAFT_STORE, WORKBOOK_STORE], 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore(DRAFT_STORE).put({ id, version: RECORD_VERSION, owner, savedAt: Date.now(), draft: metadata });
    // The original workbook can be 15 MB. Table edits only rewrite metadata.
    if (!savedFiles.has(id) || savedFiles.get(id) !== file) {
      if (file) transaction.objectStore(WORKBOOK_STORE).put({ id, file });
      else transaction.objectStore(WORKBOOK_STORE).delete(id);
    }
    await done;
    savedFiles.set(id, file);
    return true;
  });
}

export async function clearImportDraft(expectedIdentity) {
  if (expectedIdentity && !isCurrentImportDraftIdentity(expectedIdentity)) return false;
  const storage = tabStorage();
  const id = storage.getItem(TAB_KEY);
  // Remove the pointer before waiting for old writes, so a refresh cannot restore it.
  storage.removeItem(TAB_KEY);
  generation += 1;
  if (!id) return true;
  return queue(async () => {
    // A copied tab may sign out before its preview has hydrated and forked.
    // In that case only remove its pointer; the other tab owns the workbook.
    if (await holdDraftLock(id)) await deleteRecord(id);
    return true;
  });
}
