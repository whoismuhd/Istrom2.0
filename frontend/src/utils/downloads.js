/** Keep generated files available while the browser starts its download. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Some browsers consume the link after the click handler has returned.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
