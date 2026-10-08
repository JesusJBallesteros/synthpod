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

/**
 * Ask the server whether a newer version of the app exists. If so, wait for it to take over and
 * reload the page into it. Resolves to 'current' when there is nothing newer, and to
 * 'unavailable' when there is no service worker (development) or no connection.
 */
export async function checkForUpdate(): Promise<'reloading' | 'current' | 'unavailable'> {
  if (!('serviceWorker' in navigator)) return 'unavailable';
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return 'unavailable';
    await registration.update();
    if (!registration.installing && !registration.waiting) return 'current';
    // The new worker activates at once and takes control; give it a moment, then reload anyway.
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
      setTimeout(resolve, 15_000);
    });
    location.reload();
    return 'reloading';
  } catch {
    return 'unavailable';
  }
}
