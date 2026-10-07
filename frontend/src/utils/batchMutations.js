import { workspaceGeneration } from './workspaceState.js';

const sessionToken = () => globalThis.sessionStorage?.getItem('istrom_token') ?? null;
const interruptedMessage = 'Your sign-in changed. Sign in again to finish this batch.';

export async function runSessionBatch(entries, mutate, fallbackMessage = 'Could not complete this action.') {
  const generation = workspaceGeneration();
  const token = sessionToken();
  const sameSession = () => workspaceGeneration() === generation && sessionToken() === token;
  const completed = [];
  const failed = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (!sameSession()) {
      failed.push(...entries.slice(index).map((entry) => ({ entry, message: interruptedMessage })));
      break;
    }
    const entry = entries[index];
    try {
      await mutate(entry);
      completed.push(entry);
    } catch (error) {
      failed.push({ entry, message: error.message || fallbackMessage });
      if (error.name === 'AbortError' || !sameSession()) {
        failed.push(...entries.slice(index + 1).map((remaining) => ({ entry: remaining, message: interruptedMessage })));
        break;
      }
    }
  }
  return { completed, failed };
}
