export function readRecoveryToken(hash) {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return /^[A-Za-z0-9_-]{43}$/.test(token || '') ? token : null;
}
