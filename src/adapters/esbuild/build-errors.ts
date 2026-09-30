/** A project feature the build cannot handle (a preprocessor, a plugin): the run is unsupported, not an app bug. */
export class UnsupportedFeature extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFeature';
  }
}
