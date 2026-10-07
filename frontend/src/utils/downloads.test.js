import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadBlob } from './downloads.js';

test('Generated files remain readable when a browser consumes a click asynchronously', async (t) => {
  const files = new Map();
  let browserDownload;
  let cleanup;
  const link = {
    connected: false,
    click() {
      assert.equal(this.connected, true);
      browserDownload = Promise.resolve().then(async () => ({
        filename: this.download,
        contents: await files.get(this.href).text(),
      }));
    },
    remove() { this.connected = false; },
  };
  t.mock.method(URL, 'createObjectURL', (blob) => { files.set('blob:review', blob); return 'blob:review'; });
  t.mock.method(URL, 'revokeObjectURL', (url) => files.delete(url));
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'document', { configurable:true, value:{
    createElement: () => link,
    body: { appendChild: (element) => { element.connected = true; } },
  } });
  Object.defineProperty(globalThis, 'window', { configurable:true, value:{
    setTimeout: (callback) => { cleanup = callback; },
  } });
  t.after(() => {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
    else delete globalThis.document;
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else delete globalThis.window;
  });
  downloadBlob(new Blob(['Building,Amount\r\nFlats,1220']), 'budget-summary.csv');
  assert.deepEqual(await browserDownload, {filename:'budget-summary.csv', contents:'Building,Amount\r\nFlats,1220'});
  assert.equal(link.connected, false);
  cleanup();
  assert.equal(files.size, 0);
});
