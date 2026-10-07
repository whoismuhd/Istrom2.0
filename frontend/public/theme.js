// Apply the saved appearance before the page paints.
(() => {
  let theme;
  try { theme = localStorage.getItem('istrom_theme'); } catch { /* Storage may be disabled. */ }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0d1521' : '#f6f7f9');
})();
