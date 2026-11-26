/**
 * Keeps an app frame under its path. The app sees itself at / (sw.js rewrites its address), so when
 * the app reloads itself (a dev server's full reload), the browser loads / instead: outside the
 * path the service worker answers, and not cross-origin isolated, so it fails. When the frame
 * loads a document no service worker controls, or one it cannot read, this loads the app's last
 * address again under its path.
 *
 * Returns a function that reports the app's address (/path?query) whenever the frame changes it.
 */
export function guardAppFrame(frame, prefix, onAddress = () => {}) {
  let last = '/';
  let restored = 0;
  const remember = (win) => {
    last = win.location.pathname + win.location.search + win.location.hash;
    onAddress(last);
  };
  frame.addEventListener('load', () => {
    let win = null;
    try {
      win = frame.contentWindow;
      if (win.location.href === 'about:blank') return;
      if (win.navigator.serviceWorker?.controller) {
        remember(win);
        // Client-side navigations change the address without a load.
        for (const method of ['pushState', 'replaceState']) {
          const original = win.history[method].bind(win.history);
          win.history[method] = (...args) => {
            original(...args);
            remember(win);
          };
        }
        win.addEventListener('popstate', () => remember(win));
        return;
      }
    } catch {
      // an error page (cross-origin): the load failed
    }
    // Not twice in a row: an app that really cannot load stays as it is.
    if (performance.now() - restored < 2000) return;
    restored = performance.now();
    frame.src = prefix + last;
  });
}
