/** Register the service worker (production builds only) and report when the app can run offline. */
export function registerServiceWorker(onOfflineReady: (ready: boolean) => void): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const sw = navigator.serviceWorker;
  sw.addEventListener('message', (e) => {
    if (e.data?.type === 'offline') onOfflineReady(Boolean(e.data.ready));
  });
  sw.register('sw.js').then(
    () => sw.ready.then((registration) => registration.active?.postMessage('offline-status')),
    (err) => console.warn('Offline support is unavailable:', err),
  );
  // On hosts that cannot send the isolation headers, the service worker adds them, but only to
  // pages it already controls. So reload once, the first time, as soon as it has taken control.
  if (!self.crossOriginIsolated && !sessionStorage.getItem('synthpod.reloaded')) {
    const reload = () => {
      sessionStorage.setItem('synthpod.reloaded', '1');
      location.reload();
    };
    if (sw.controller) reload();
    else sw.addEventListener('controllerchange', reload, { once: true });
  }
}
