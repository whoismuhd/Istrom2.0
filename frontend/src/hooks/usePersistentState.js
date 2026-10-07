import { useState } from 'react';
import { useAuth } from '../contexts/useAuth';
import { workspaceStateKey, workspaceGeneration, readWorkspaceState, writeWorkspaceState, removeWorkspaceState } from '../utils/workspaceState';

export function usePersistentState(name, initial, options = {}) {
  const { user, getEffectiveProjectSite } = useAuth();
  const key = workspaceStateKey(user, getEffectiveProjectSite(), name, options.scope);
  const generation = workspaceGeneration();
  const [entry, setEntry] = useState(() => ({ key, generation,
    ...readWorkspaceState(key, initial, options.validate) }));
  let current = entry;
  if (entry.key !== key || entry.generation !== generation) {
    current = { key, generation, ...readWorkspaceState(key, initial, options.validate) };
    setEntry(current);
  }
  let latestValue = current.value;
  const setValue = (next) => {
    if (workspaceGeneration() !== generation) return 'Your sign-in changed. Please sign in again.';
    latestValue = typeof next === 'function' ? next(latestValue) : next;
    // Save within the input event, before a refresh can unmount the screen.
    const error = writeWorkspaceState(key, latestValue, initial, options.validate);
    setEntry((previous) => previous.key === key && previous.generation === generation
      ? { key, generation, value: latestValue, error } : previous);
    return error;
  };
  const clearValue = (expected = current.value) => {
    if (workspaceGeneration() !== generation) return false;
    const result = removeWorkspaceState(key, expected, initial, options.validate);
    if (result.cleared) latestValue = initial;
    setEntry((previous) => previous.key === key && previous.generation === generation
      ? { key, generation, value: result.cleared ? initial : previous.value, error: result.error } : previous);
    return result.cleared;
  };
  return [current.value, setValue, clearValue, current.error];
}

export default usePersistentState;
