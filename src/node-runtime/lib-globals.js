// Injected into the runtime libraries (bundle.ts, RUNTIME_LIBS): their free Buffer and process are the
// runtime's, as globals-shim.ts makes them in the runtime's own script. Both resolve to the runtime's modules.
import { Buffer } from 'buffer';
import process from 'process/';

export { Buffer, process };
