// Resolved at bundle time to the selected adapter's browser entry.
declare module 'sandburg:adapter' {
  export function createAdapter(): import('./types.ts').RuntimeAdapter;
  /** Called once as the host page loads, before any run: work a run will need, started early. */
  export function prepare(): void;
}
