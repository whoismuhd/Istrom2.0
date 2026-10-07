function cancelledAttempt() {
  const error = new Error('This sign-in attempt is no longer current.');
  error.name = 'AbortError';
  return error;
}

// Authentication responses can finish after another account or screen takes over.
export function createAuthTransitions(readToken) {
  let version = 0;
  let pendingSignOut = null;
  const invalidate = () => { version += 1; };

  const authenticate = async (operation, accept, signal) => {
    const attempt = ++version;
    const token = readToken();
    if (signal?.aborted) throw cancelledAttempt();
    const response = await operation();
    if (signal?.aborted || attempt !== version || token !== readToken()) throw cancelledAttempt();
    return accept(response);
  };

  const resetPassword = async (operation, clearSession, signal) => {
    const attempt = ++version;
    const token = readToken();
    if (signal?.aborted) throw cancelledAttempt();
    const response = await operation();
    if (signal?.aborted) throw cancelledAttempt();
    // Public recovery can succeed after the old session expires. Keep its result
    // visible, but clear local work only when the original session is still current.
    if (attempt === version && token === readToken()) clearSession();
    return response;
  };

  const signOut = (cleanup, clearSession) => {
    const token = readToken();
    if (pendingSignOut?.token === token && pendingSignOut.attempt === version) return pendingSignOut.promise;
    const attempt = ++version;
    const action = { token, attempt };
    action.promise = (async () => {
      try { await cleanup(); } catch { /* Local sign-out still completes when device cleanup fails. */ }
      if (attempt !== version || token !== readToken()) return false;
      clearSession();
      return true;
    })().finally(() => { if (pendingSignOut === action) pendingSignOut = null; });
    pendingSignOut = action;
    return action.promise;
  };

  return { authenticate, resetPassword, signOut, invalidate };
}
