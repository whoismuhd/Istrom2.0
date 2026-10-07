/* ISTROM service worker: receives Web Push events and shows system
   notifications while the app/tab is closed. */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'ISTROM', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'ISTROM';
  const options = {
    body: data.body || '',
    icon: '/istrom-icon.png',
    badge: '/istrom-badge.png',
    tag: data.notification_id ? `istrom-${data.notification_id}` : undefined,
    data: { url: data.url || '/notifications' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/notifications';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
      for (const tab of tabs) {
        if ('focus' in tab) {
          tab.navigate(url);
          return tab.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
