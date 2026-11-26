/**
 * Keeps an app frame under the app's path (`prefix`) when the app reloads itself, and reports the
 * app's address (/path?query#hash) whenever the frame changes it (frame-guard.js).
 */
export function guardAppFrame(frame: HTMLIFrameElement, prefix: string, onAddress?: (address: string) => void): void;
