/**
 * What Testing Library's user-event takes from @testing-library/dom: its configuration, nothing
 * else. In place of that package (and its pretty-printing and ARIA tables) in the page checks'
 * bundle.
 */
export const getConfig = () => ({
  asyncWrapper: (cb: () => unknown) => cb(),
  eventWrapper: (cb: () => unknown) => cb(),
  getElementError: (message: string) => new Error(message),
});
