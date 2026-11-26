/**
 * Why a page is not cross-origin isolated after the reload that should have made it so (its
 * service worker adds the headers that static hosting cannot set), worded for the visitor.
 */
export function isolationFailure() {
  if (!navigator.serviceWorker.controller) {
    return 'This page needs its service worker, which did not handle the reload: a hard reload, a private window, or a setting or extension that blocks service workers. Reload the page normally.';
  }
  if (!('crossOriginIsolated' in self)) {
    return 'This browser does not support cross-origin isolation, which the Node.js runtime needs for its shared memory. Use a recent Chrome, Edge, Firefox or Safari.';
  }
  return 'The browser did not make this page cross-origin isolated, which the Node.js runtime needs for its shared memory. Reload the page; if that does not help, try a recent Chrome, Edge or Firefox.';
}
