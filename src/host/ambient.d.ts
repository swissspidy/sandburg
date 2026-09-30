// Resolved at bundle time to the selected adapter's browser entry.
declare module 'sandburg:adapter' {
  export function createAdapter(): import('./types.ts').RuntimeAdapter;
}
