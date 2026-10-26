/**
 * The file channel's wire format, shared by its two ends: the host (orchestrator/host-socket.ts,
 * which answers) and a runtime's helper worker (node-runtime/host-files.ts, which asks). A runtime
 * asks the host for installed files over a WebSocket of its own instead of synchronous HTTP (a
 * WebSocket's messages are not intercepted by Playwright: ~0.5 ms a request instead of 5-7 ms).
 *
 * - A GET is a text frame `<id> <path>?<query>`; id 0 is a note (the host answers it, the helper
 *   drops the answer): the files a runtime read, or a file sent ahead that it used.
 * - A POST is a binary frame: the id and the path's length (u32 little-endian each), the path, then
 *   the body.
 * - An answer is a binary frame: the id and the HTTP status (u32 little-endian each, ANSWER_HEADER
 *   bytes), then the body. Status 0 means "ask over HTTP": the path is not one the
 *   channel serves, or the body is over MAX_BODY.
 * - The helper hands a GET's answer to the waiting runtime in shared memory: three i32 (state, the
 *   body's length, the status), then the body, which MAX_BODY bounds (MAILBOX_BYTES).
 */

/** The channel's name under its host page's base (a runtime opens `<base>/files`). */
export const FILE_CHANNEL_NAME = 'files';
/** Where the host accepts the channel: under the host page's base on a sandbox origin. */
export const FILE_CHANNEL_PATH = `/__sandburg/${FILE_CHANNEL_NAME}`;
/** Larger bodies are answered with status 0 (over a WebSocket, 40 MB took 4x as long as over HTTP). */
export const MAX_BODY = 1 << 20;
/** Larger text frames from a runtime close the channel: a request is `<id> <path>`, and nothing is buffered beyond this. */
export const MAX_FRAME = 1 << 16;
/** Larger POST frames close the channel (a transform's code and options; the route's own bound is 4 MB). */
export const MAX_POST = (4 << 20) + MAX_FRAME;
/**
 * A runtime's compile is posted over the channel when its code is shorter (larger code, next dev's
 * chunks, is asked for by digest first and posted over HTTP); its answer still has to fit MAX_BODY.
 */
export const COMPILE_POST_MAX = 1 << 18;
/** An answer's header: the id and the status. */
export const ANSWER_HEADER = 8;
/** A POST's header: the id and the path's length. */
export const POST_HEADER = 8;
/** A runtime's mailbox for one answer: the state, the body's length and the status (i32 each), then the body. */
export const MAILBOX_HEADER = 12;
export const MAILBOX_BYTES = MAILBOX_HEADER + MAX_BODY;
