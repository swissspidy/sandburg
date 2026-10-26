/**
 * AsyncLocalStorage across native `await` (ADR NNNN).
 *
 * The runtime carries async context itself (async-context.ts): it captures the context when a
 * callback is scheduled (Promise.prototype.then, queueMicrotask, timers) and restores it when the
 * callback runs. A native `await` resumes without any of those, so async functions used to be
 * lowered to generators driven by `.then` (esbuild's `__async`): ~10 times the cost of a native
 * await per step.
 *
 * Instead, async functions stay native and each `await` restores the context itself:
 *
 *   async function f(x) {                 async function f(x) {
 *     try {                                 const __sbac = __sandburg_ac.e(); try {
 *       const v = await g(x);                 try {
 *       return use(v);              →           const v = __sandburg_ac.r(__sbac, await __sandburg_ac.s(__sbac, g(x)));
 *     } catch (e) {                             return use(v);
 *       log(e);                               } catch (e) {__sandburg_ac.k(__sbac);
 *     }                                         log(e);
 *   }                                         }
 *                                           } finally { __sandburg_ac.x(__sbac); }}
 *
 * `s` notes the function's context as it suspends (and hands the microtask that resumed it its own
 * context back), `r` restores it when the await resumes, `k` when a rejected await resumes in a
 * catch or finally block, and `x` hands the context back as the function returns or throws. Each
 * call has its own state (`__sbac`; a nested async function's shadows it). The awaited value is
 * passed through unchanged, so an await takes as many ticks as before. Nothing is inserted on a new
 * line: line numbers stay.
 *
 * The rewrite needs where each `await`'s operand ends, which a scan of the tokens finds (no parse,
 * ~10x faster than acorn): it runs on esbuild's output, which is normalized (semicolons, no
 * comments but annotations). It answers null when it meets something it does not expect, and the
 * caller then lowers the code as before (and checks that what it gets parses).
 */

import { AWAIT_CONTEXT_GLOBAL } from './names.ts';

const LOCAL = '__sbac';
const G = AWAIT_CONTEXT_GLOBAL;

/** What a rewrite inserts, by kind; at one position, in this order. */
const Edit = { AwaitClose: 0, BodyEnd: 1, ExpressionEnd: 2, BodyStart: 3, ExpressionStart: 4, AwaitOpen: 5, AwaitOperand: 6, Resumed: 7 } as const;
type Edit = (typeof Edit)[keyof typeof Edit];
const BODY_START = `const ${LOCAL} = ${G}.e(); try { `;
const BODY_END = ` } finally { ${G}.x(${LOCAL}); }`;
const TEXT: Record<Edit, string> = {
  [Edit.AwaitClose]: '))',
  [Edit.BodyEnd]: BODY_END,
  // An arrow's expression body becomes a block that returns it.
  [Edit.ExpressionEnd]: `;${BODY_END} }`,
  [Edit.BodyStart]: BODY_START,
  [Edit.ExpressionStart]: `{ ${BODY_START}return `,
  [Edit.AwaitOpen]: `${G}.r(${LOCAL}, `,
  [Edit.AwaitOperand]: ` ${G}.s(${LOCAL},`,
  [Edit.Resumed]: `${G}.k(${LOCAL});`,
};

/** Words after which an expression starts (so a `/` there begins a regular expression). */
const BEFORE_EXPRESSION = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else',
  'extends', 'yield', 'await', 'export', 'default', 'if', 'while', 'for', 'with', 'switch', 'catch',
  'var', 'let', 'const', 'import', 'try', 'finally', 'function', 'class',
]);
/** Words that are unary operators before an await's operand. */
const PREFIX_WORDS = new Set(['typeof', 'void', 'delete', 'await', 'new']);
/** Keywords whose `( … )` is a statement's head: a statement follows its `)`. */
const CONTROL = new Set(['if', 'while', 'for', 'with', 'switch']);

/** Token types: a word (identifier, keyword, #private), number, string or regular expression, a template literal's part, punctuator, ( [ {, ) ] }, the end. */
const T = { Word: 0, Num: 1, Str: 2, Template: 3, Punct: 4, Open: 5, Close: 6, Eof: 7 } as const;
type T = (typeof T)[keyof typeof T];

interface Frame {
  /** An async function's frame: its awaits are rewritten. */
  async: boolean;
  /** An expression body (an arrow's): it ends at a `,`, `;`, `:` or closing bracket of its depth. */
  expression: boolean;
  /** Bracket depth of the body's contents. */
  depth: number;
  bodyStart: number;
  edits: [number, Edit][];
  awaits: number;
  /** Open `?`s of conditionals at an expression body's depth. */
  conditionals: number;
}

interface PendingAwait {
  frame: Frame;
  depth: number;
  /** 0: prefix operators, before the primary; 1: the postfix chain; 2: after `.` or `?.` (a name follows); 3: in a function or class expression (until its body closes). */
  phase: number;
}

interface Group {
  kind: number; // char code of ( [ {
  /** `{`: a block, an object literal, a class body, a function body, or a template's `${`. */
  brace?: 'block' | 'object' | 'class' | 'fn' | 'template';
  /** `(`: the keyword before it (if, for, catch …), when it is not a property. */
  before?: string;
  /** `(`: a function's or method's parameters (its body follows), whether that function is async, and whether it is an expression (an operator may follow its body). */
  params?: boolean;
  async?: boolean;
  expression?: boolean;
  /** `{` of a function body: its frame. */
  frame?: Frame;
  /** `}`: whether an operator may follow (the braces were an expression). */
  exprAfter?: boolean;
  /** `{` of a class body or object literal: the member being read. */
  member?: Member;
  /** `{` of a block: a `case`/`default` label was read and its `:` is due. */
  caseDue?: boolean;
}

/**
 * Rewrites the native awaits of `code` (esbuild's output: a CommonJS module or script body) so that
 * they restore the async context. The code itself when it has no await; null when the scan meets
 * something it does not understand.
 */
export function rewriteAwaits(code: string): string | null {
  if (!code.includes('await')) return code;
  try {
    return new Scanner(code).run();
  } catch (e) {
    if (e instanceof Unsupported) return null;
    throw e;
  }
}

/**
 * rewriteAwaits, checked: the rewritten code must parse (compiled, never called, here). Null to
 * lower the code instead.
 */
export function contextAwaits(code: string): string | null {
  const out = rewriteAwaits(code);
  if (out === null || out === code) return out;
  try {
    // oxlint-disable-next-line typescript/no-implied-eval -- a syntax check: the function is never called
    new Function(out);
    return out;
  } catch {
    return null;
  }
}

class Unsupported extends Error {}

class Scanner {
  private readonly code: string;
  // The current token.
  private type: T = T.Eof;
  private start = 0;
  private end = 0;
  private value = '';
  private newlineBefore = false;
  /** The bracket depth the current token is at (a template part may open a `${` group as it is read). */
  private depth = 0;
  /** Whether the current token ends an expression (a `/` after it divides). */
  private exprEnd = false;
  /** Whether the current word is a property name (after `.` or `?.`). */
  private property = false;
  // The previous token.
  private prevType: T = T.Eof;
  private prevValue = '';
  private prevEnd = 0;
  private prevExprEnd = false;
  private prevProperty = false;
  /** The word before the previous token, when the previous token is a word (`async x =>`). */
  private prevPrevWord = '';
  private prevNewlineBefore = false;
  /** The previous token was the `:` of a `case`/`default` label (a statement follows). */
  private prevCaseColon = false;
  private caseColon = false;

  private groups: Group[] = [];
  private frames: Frame[] = [];
  private done: Frame[] = [];
  private pending: PendingAwait[] = [];
  /** After `function` (and `*`, a name): its parameters' `(` follows at this depth. */
  private functionDue: { async: boolean; expression: boolean; depth: number } | null = null;
  /** After `class`: its body's `{` follows at this depth. */
  private classDue: { expression: boolean; depth: number } | null = null;
  /** After `=>`: an arrow's body follows. */
  private arrowDue: { async: boolean } | null = null;
  /** The `(` group that closed last. */
  private lastParen: Group | null = null;
  /** At an `async` word: whether it began a statement (for `async function`'s kind). */
  private asyncAtStatement = false;
  /** Whether the previous token was a word at the start of a statement (a label's name, before its `:`). */
  private wordAtStatement = false;
  private prevWordAtStatement = false;

  constructor(code: string) {
    this.code = code;
  }

  run(): string {
    this.frames.push({ async: false, expression: false, depth: 0, bodyStart: 0, edits: [], awaits: 0, conditionals: 0 });
    for (;;) {
      this.next();
      if (this.type === T.Eof) break;
      this.token();
    }
    this.endPending(0);
    while (this.frame.expression) this.endExpressionBody();
    if (this.groups.length || this.frames.length !== 1 || this.functionDue || this.classDue || this.arrowDue) throw new Unsupported('unbalanced');
    const edits: [number, Edit][] = [];
    for (const f of this.done) if (f.async && f.awaits) edits.push(...f.edits);
    if (!edits.length) return this.code;
    edits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let out = '';
    let at = 0;
    for (const [pos, kind] of edits) {
      out += this.code.slice(at, pos) + TEXT[kind];
      at = pos;
    }
    return out + this.code.slice(at);
  }

  private get frame(): Frame {
    return this.frames[this.frames.length - 1];
  }

  private get top(): Group | undefined {
    return this.groups[this.groups.length - 1];
  }

  private newFrame(async: boolean, expression: boolean, bodyStart: number): Frame {
    return { async, expression, depth: this.groups.length, bodyStart, edits: [], awaits: 0, conditionals: 0 };
  }

  /** Whether the previous token leaves the scan at the start of a statement. */
  private atStatement(): boolean {
    switch (this.prevType) {
      case T.Eof:
        return true;
      case T.Punct:
        return this.prevValue === ';' || this.prevCaseColon;
      case T.Open:
        return this.prevValue === '{' && this.top?.brace !== 'object' && this.top?.brace !== 'class';
      case T.Close:
        return (this.prevValue === '}' && !this.prevExprEnd) || (this.prevValue === ')' && CONTROL.has(this.lastParen?.before ?? ''));
      case T.Word:
        return !this.prevProperty && (this.prevValue === 'else' || this.prevValue === 'do');
      default:
        return false;
    }
  }

  private token(): void {
    this.advancePending();
    const { type, value } = this;
    // An arrow's expression body ends at a `,`, `;` or unmatched `:` of its depth.
    while (this.frame.expression && this.depth === this.frame.depth && type === T.Punct) {
      const f = this.frame;
      if (value === '?') f.conditionals++;
      else if (value === ':' && f.conditionals > 0) f.conditionals--;
      else if (value === ',' || value === ';' || value === ':') {
        this.endExpressionBody();
        continue;
      }
      break;
    }
    if (this.arrowDue) {
      const { async } = this.arrowDue;
      this.arrowDue = null;
      if (type === T.Open && value === '{') {
        const frame = this.newFrame(async, false, this.afterDirectives(this.end));
        frame.depth++;
        this.push({ kind: 123, brace: 'fn', frame, exprAfter: true });
        return;
      }
      const frame = this.newFrame(async, true, this.start);
      frame.depth = this.depth;
      this.frames.push(frame);
    }
    switch (type) {
      case T.Open:
        return this.open();
      case T.Close:
        return this.close();
      case T.Word:
        return this.word();
      case T.Punct:
        return this.punct();
      default:
        this.memberToken(value);
    }
  }

  private punct(): void {
    const value = this.value;
    if (value === '=>') {
      // `async (…) =>` or `async x =>`.
      const async =
        this.prevType === T.Close && this.prevValue === ')' ? !!this.lastParen?.async : this.prevType === T.Word && this.prevPrevWord === 'async' && !this.prevNewlineBefore;
      this.arrowDue = { async };
      this.functionDue = null;
      return;
    }
    const top = this.top;
    if (value === ':' && top?.caseDue) {
      top.caseDue = false;
      this.caseColon = true;
    } else if (value === ':' && this.prevType === T.Word && this.prevWordAtStatement && top?.brace !== 'object' && top?.brace !== 'class') {
      // A label: a statement follows.
      this.caseColon = true;
    }
    if (top?.member) {
      if (value === ',' || value === ';') resetMember(top.member);
      else if (value !== '*') noteMember(top.member, value);
    }
  }

  private memberToken(value: string): void {
    const top = this.top;
    if (top?.member) noteMember(top.member, value);
  }

  private word(): void {
    const { value } = this;
    this.wordAtStatement = !this.property && this.atStatement();
    if (!this.property) {
      if (value === 'function' && this.peek() !== ':') {
        const async = this.prevType === T.Word && this.prevValue === 'async' && !this.prevProperty && !this.newlineBefore;
        this.functionDue = { async, expression: !(async ? this.asyncAtStatement : this.atStatement()), depth: this.groups.length };
      } else if (value === 'class' && this.peek() !== ':') {
        this.classDue = { expression: !this.atStatement(), depth: this.groups.length };
      } else if (value === 'async') {
        this.asyncAtStatement = this.atStatement();
      } else if ((value === 'case' || value === 'default') && this.top?.brace === 'block') {
        this.top.caseDue = true;
      } else if (value === 'await' && this.frame.async && this.peek() !== ':') {
        this.frame.awaits++;
        this.frame.edits.push([this.start, Edit.AwaitOpen], [this.end, Edit.AwaitOperand]);
        this.pending.push({ frame: this.frame, depth: this.groups.length, phase: 0 });
      }
    }
    if (!this.property) this.memberToken(value);
  }

  private open(): void {
    const value = this.value;
    const top = this.top;
    if (value === '(') {
      const g: Group = { kind: 40, before: this.prevType === T.Word && !this.prevProperty ? this.prevValue : '' };
      if (this.functionDue && this.functionDue.depth === this.groups.length) {
        g.params = true;
        g.async = this.functionDue.async;
        g.expression = this.functionDue.expression;
        this.functionDue = null;
      } else if (top?.member && top.member.n && !top.member.assigned && (this.prevType === T.Word || this.prevType === T.Str || this.prevType === T.Num || (this.prevType === T.Close && this.prevValue === ']'))) {
        // A method: `name(`, `async name(`, `get [key](` in a class body or object literal.
        g.params = true;
        // `async` before the name (the last token, or a computed key) is the modifier.
        g.async = top.member.asyncAt >= 0 && top.member.asyncAt < top.member.n - 1;
        g.expression = true;
      } else {
        // `async (…) =>` (an arrow's parameters, or a call of a function named async).
        g.async = this.prevType === T.Word && this.prevValue === 'async' && !this.prevProperty && !this.newlineBefore;
      }
      this.memberToken('(');
      return this.push(g);
    }
    if (value === '[') {
      this.memberToken('[');
      return this.push({ kind: 91 });
    }
    // `{`
    if (this.classDue && this.classDue.depth === this.groups.length) {
      const g: Group = { kind: 123, brace: 'class', member: newMember(), exprAfter: this.classDue.expression };
      this.classDue = null;
      return this.push(g);
    }
    if (this.prevType === T.Close && this.prevValue === ')' && this.lastParen?.params) {
      // A function's or method's body.
      const frame = this.newFrame(!!this.lastParen.async, false, this.afterDirectives(this.end));
      frame.depth++;
      this.memberToken('{');
      return this.push({ kind: 123, brace: 'fn', frame, exprAfter: !!this.lastParen.expression });
    }
    if (this.atStatement() || (this.prevType === T.Close && this.prevValue === ')') || (this.prevType === T.Word && !this.prevProperty && (this.prevValue === 'try' || this.prevValue === 'finally' || this.prevValue === 'catch' || this.prevValue === 'static'))) {
      // A block: a catch or finally block is where a rejected await resumes.
      const resumes = (this.prevType === T.Word && !this.prevProperty && (this.prevValue === 'finally' || this.prevValue === 'catch')) || (this.prevType === T.Close && this.prevValue === ')' && this.lastParen?.before === 'catch');
      if (resumes) this.frame.edits.push([this.end, Edit.Resumed]);
      this.memberToken('{');
      return this.push({ kind: 123, brace: 'block' });
    }
    this.memberToken('{');
    this.push({ kind: 123, brace: 'object', member: newMember(), exprAfter: true });
  }

  private push(g: Group): void {
    this.groups.push(g);
    if (g.frame) this.frames.push(g.frame);
  }

  /** Where a body's prologue goes: after `{` and its directives ("use strict";). */
  private afterDirectives(at: number): number {
    const re = /\s*(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')\s*;/y;
    for (;;) {
      re.lastIndex = at;
      if (!re.exec(this.code)) return at;
      at = re.lastIndex;
    }
  }

  private close(): void {
    const value = this.value;
    const g = this.groups.pop();
    const kind = value === ')' ? 40 : value === ']' ? 91 : 123;
    if (!g || g.kind !== kind || g.brace === 'template') throw new Unsupported('mismatched');
    this.closed(g);
  }

  /** After a group closed (its closing token is the current one). */
  private closed(g: Group): void {
    this.endPending(this.groups.length);
    while (this.frame.expression && this.groups.length < this.frame.depth) this.endExpressionBody();
    if (g.kind === 40) {
      this.lastParen = g;
      this.exprEnd = !CONTROL.has(g.before ?? '') && g.before !== 'catch';
    } else if (g.kind === 91) this.exprEnd = true;
    else {
      if (g.frame) {
        const frame = this.frames.pop();
        if (frame !== g.frame) throw new Unsupported('frames');
        this.finish(frame, this.start);
        // A class member ends with its method's body.
        if (this.top?.brace === 'class' && this.top.member) resetMember(this.top.member);
      }
      this.exprEnd = !!g.exprAfter;
    }
    for (const p of this.pending) {
      if (p.depth !== this.groups.length) continue;
      // The group was the operand's primary, a call's arguments or an index; or a function or class
      // expression's parameters (still in it) or body (the chain follows).
      if (p.phase === 3) {
        if (g.kind === 123) p.phase = 1;
      } else p.phase = 1;
    }
  }

  private finish(frame: Frame, end: number): void {
    if (frame.async && frame.awaits) frame.edits.push([frame.bodyStart, Edit.BodyStart], [end, Edit.BodyEnd]);
    this.done.push(frame);
  }

  private endExpressionBody(): void {
    const frame = this.frames.pop()!;
    // The body ends after the previous token: an await in it closes there first.
    for (let i = this.pending.length - 1; i >= 0; i--) if (this.pending[i].frame === frame) this.endAwait(i, this.prevEnd);
    if (frame.async && frame.awaits) frame.edits.push([frame.bodyStart, Edit.ExpressionStart], [this.prevEnd, Edit.ExpressionEnd]);
    this.done.push(frame);
  }

  private peek(): string {
    let i = this.end;
    const code = this.code;
    while (i < code.length && (code[i] === ' ' || code[i] === '\n' || code[i] === '\t' || code[i] === '\r')) i++;
    return code[i] ?? '';
  }

  /**
   * Moves pending awaits on with the current token: at an await's depth, a token that cannot
   * continue its operand (a unary expression) ends it before the token.
   */
  private advancePending(): void {
    const depth = this.depth;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (p.depth !== depth) continue;
      const { type, value } = this;
      switch (p.phase) {
        case 0:
          if (type === T.Word && (PREFIX_WORDS.has(value) || value === 'async')) continue;
          if (type === T.Punct && (value === '!' || value === '~' || value === '+' || value === '-' || value === '++' || value === '--')) continue;
          if (type === T.Word && (value === 'function' || value === 'class')) p.phase = 3;
          else if (type === T.Word || type === T.Num || type === T.Str || type === T.Template) p.phase = 1;
          else if (type !== T.Open) throw new Unsupported('await operand');
          continue;
        case 2:
          if (type === T.Word) p.phase = 1;
          else if (type !== T.Open) throw new Unsupported('member');
          continue;
        case 3:
          continue;
      }
      // The postfix chain: members, calls, indexes, tagged templates, a postfix ++/--.
      if (type === T.Punct && (value === '.' || value === '?.')) p.phase = 2;
      else if ((type === T.Open && value !== '{') || type === T.Template) continue;
      else if (type === T.Punct && (value === '++' || value === '--') && !this.newlineBefore) this.endAwait(i, this.end);
      else this.endAwait(i, this.prevEnd);
    }
  }

  private endAwait(i: number, at: number): void {
    const p = this.pending[i];
    this.pending.splice(i, 1);
    p.frame.edits.push([at, Edit.AwaitClose]);
  }

  /** Ends the awaits deeper than `depth`: a bracket closed. */
  private endPending(depth: number): void {
    for (let i = this.pending.length - 1; i >= 0; i--) if (this.pending[i].depth > depth) this.endAwait(i, this.prevEnd);
  }

  // --- tokens ---------------------------------------------------------------------------------

  private next(): void {
    this.prevPrevWord = this.prevType === T.Word ? this.prevValue : '';
    this.prevType = this.type;
    this.prevValue = this.value;
    this.prevEnd = this.end;
    this.prevExprEnd = this.exprEnd;
    this.prevProperty = this.property;
    this.prevNewlineBefore = this.newlineBefore;
    this.prevCaseColon = this.caseColon;
    this.caseColon = false;
    this.prevWordAtStatement = this.wordAtStatement;
    this.wordAtStatement = false;
    this.property = false;
    const code = this.code;
    let i = this.end;
    let newline = false;
    for (;;) {
      const c = code.charCodeAt(i);
      if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) {
        newline = true;
        i++;
      } else if (c === 32 || c === 9 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff) i++;
      else if (c === 47 && code.charCodeAt(i + 1) === 47) {
        const e = code.indexOf('\n', i);
        i = e < 0 ? code.length : e;
      } else if (c === 47 && code.charCodeAt(i + 1) === 42) {
        const e = code.indexOf('*/', i + 2);
        if (e < 0) throw new Unsupported('comment');
        if (code.slice(i, e).includes('\n')) newline = true;
        i = e + 2;
      } else break;
    }
    this.newlineBefore = newline;
    this.start = i;
    this.depth = this.groups.length;
    if (i >= code.length) {
      this.type = T.Eof;
      this.end = i;
      this.value = '';
      return;
    }
    const c = code.charCodeAt(i);
    if (c === 125 && this.top?.brace === 'template') {
      // A template's next part, back from `${ … }`.
      this.groups.pop();
      this.closedSubstitution();
      this.depth = this.groups.length;
      this.type = T.Template;
      this.value = '`';
      this.end = this.template(i + 1);
      return;
    }
    if (isIdentStart(c) || c === 35) {
      let j = i + 1;
      while (j < code.length && isIdentPart(code.charCodeAt(j))) j++;
      this.end = j;
      this.type = T.Word;
      this.value = wordName(code, i, j);
      this.property = this.prevType === T.Punct && (this.prevValue === '.' || this.prevValue === '?.');
      this.exprEnd = this.property || !BEFORE_EXPRESSION.has(this.value);
      return;
    }
    if ((c >= 48 && c <= 57) || (c === 46 && code.charCodeAt(i + 1) >= 48 && code.charCodeAt(i + 1) <= 57)) {
      this.end = numberEnd(code, i);
      this.type = T.Num;
      this.value = '0';
      this.exprEnd = true;
      return;
    }
    if (c === 34 || c === 39) {
      let j = i + 1;
      for (;;) {
        const d = code.charCodeAt(j);
        if (Number.isNaN(d) || d === 10) throw new Unsupported('string');
        if (d === 92) j += 2;
        else if (d === c) break;
        else j++;
      }
      this.end = j + 1;
      this.type = T.Str;
      this.value = '"';
      this.exprEnd = true;
      return;
    }
    if (c === 96) {
      this.type = T.Template;
      this.value = '`';
      this.end = this.template(i + 1);
      return;
    }
    if (c === 47 && !this.prevExprEnd) {
      this.end = regexEnd(code, i + 1);
      this.type = T.Str;
      this.value = '/';
      this.exprEnd = true;
      return;
    }
    if (c === 40 || c === 91 || c === 123) {
      this.end = i + 1;
      this.type = T.Open;
      this.value = code[i];
      this.exprEnd = false;
      return;
    }
    if (c === 41 || c === 93 || c === 125) {
      this.end = i + 1;
      this.type = T.Close;
      this.value = code[i];
      this.exprEnd = true; // decided in closed()
      return;
    }
    this.end = i + punctuatorLength(code, i);
    this.type = T.Punct;
    this.value = code.slice(i, this.end);
    // A postfix ++/-- ends an expression; a prefix one does not.
    this.exprEnd = (this.value === '++' || this.value === '--') && this.prevExprEnd;
  }

  /** A template's part, from after its backtick or `}`: up to its end (an expression end) or the next `${` (a group opens). */
  private template(i: number): number {
    const code = this.code;
    for (;;) {
      const d = code.charCodeAt(i);
      if (Number.isNaN(d)) throw new Unsupported('template');
      if (d === 92) i += 2;
      else if (d === 96) {
        this.exprEnd = true;
        return i + 1;
      } else if (d === 36 && code.charCodeAt(i + 1) === 123) {
        this.groups.push({ kind: 123, brace: 'template' });
        this.exprEnd = false;
        return i + 2;
      } else i++;
    }
  }

  /** A template's substitution closed: what was pending in it ends there (as closed() does for a group). */
  private closedSubstitution(): void {
    this.endPending(this.groups.length);
    while (this.frame.expression && this.groups.length < this.frame.depth) this.endExpressionBody();
  }
}

/** The member of a class body or object literal being read: its tokens so far, where its first `async` is, and whether a `:` or `=` made it a property. */
interface Member {
  n: number;
  asyncAt: number;
  assigned: boolean;
}

const newMember = (): Member => ({ n: 0, asyncAt: -1, assigned: false });

function resetMember(m: Member): void {
  m.n = 0;
  m.asyncAt = -1;
  m.assigned = false;
}

function noteMember(m: Member, value: string): void {
  if (value === 'async' && m.asyncAt < 0) m.asyncAt = m.n;
  else if (value === ':' || value === '=') m.assigned = true;
  m.n++;
}

/** The words that matter by name, by first letter: other words are all "$" (no string made for them). */
const NAMED = new Map<number, string[]>();
for (const w of [...BEFORE_EXPRESSION, ...PREFIX_WORDS, ...CONTROL, 'async', 'case', 'default', 'static', 'get', 'set', 'this', 'super']) {
  const list = NAMED.get(w.charCodeAt(0)) ?? [];
  if (!list.includes(w)) list.push(w);
  NAMED.set(w.charCodeAt(0), list);
}

function wordName(code: string, i: number, j: number): string {
  const list = NAMED.get(code.charCodeAt(i));
  if (!list) return '$';
  for (const w of list) if (w.length === j - i && code.startsWith(w, i)) return w;
  return '$';
}

/** ASCII characters by class: 1 starts an identifier (and continues one), 2 only continues one. */
const IDENT = new Uint8Array(128);
for (let c = 0; c < 128; c++) IDENT[c] = (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95 || c === 92 ? 1 : c >= 48 && c <= 57 ? 2 : 0;

function isIdentStart(c: number): boolean {
  return c > 127 ? true : IDENT[c] === 1;
}

function isIdentPart(c: number): boolean {
  return c > 127 ? true : IDENT[c] !== 0;
}

function numberEnd(code: string, i: number): number {
  let j = i;
  if (code.charCodeAt(j) === 48 && /[xXoObB]/.test(code[j + 1] ?? '')) {
    j += 2;
    while (j < code.length && /[0-9a-fA-F_n]/.test(code[j])) j++;
    return j;
  }
  while (j < code.length && /[0-9_.]/.test(code[j])) j++;
  if (/[eE]/.test(code[j] ?? '')) {
    j++;
    if (code[j] === '+' || code[j] === '-') j++;
    while (j < code.length && /[0-9_]/.test(code[j])) j++;
  }
  if (code[j] === 'n') j++;
  return j;
}

function regexEnd(code: string, i: number): number {
  let inClass = false;
  for (;;) {
    const d = code.charCodeAt(i);
    if (Number.isNaN(d) || d === 10) throw new Unsupported('regex');
    if (d === 92) i += 2;
    else if (d === 91) {
      inClass = true;
      i++;
    } else if (d === 93) {
      inClass = false;
      i++;
    } else if (d === 47 && !inClass) {
      i++;
      while (i < code.length && isIdentPart(code.charCodeAt(i))) i++;
      return i;
    } else i++;
  }
}

/** The length of the punctuator at `i` (the longest match). */
function punctuatorLength(code: string, i: number): number {
  const c = code.charCodeAt(i);
  const d = code.charCodeAt(i + 1);
  const e = code.charCodeAt(i + 2);
  switch (c) {
    case 46: // . ...
      return d === 46 && e === 46 ? 3 : 1;
    case 61: // = == === =>
      return d === 61 ? (e === 61 ? 3 : 2) : d === 62 ? 2 : 1;
    case 33: // ! != !==
      return d === 61 ? (e === 61 ? 3 : 2) : 1;
    case 63: // ? ?. ?? ??=  (`?.` before a digit is a conditional's `?` and a number: `a?.5:1`)
      if (d === 63) return e === 61 ? 3 : 2;
      return d === 46 && !(e >= 48 && e <= 57) ? 2 : 1;
    case 42: // * ** *= **=
      if (d === 42) return e === 61 ? 3 : 2;
      return d === 61 ? 2 : 1;
    case 38: // & && &= &&=
    case 124: // | || |= ||=
      if (d === c) return e === 61 ? 3 : 2;
      return d === 61 ? 2 : 1;
    case 43: // + ++ +=
    case 45: // - -- -=
      return d === c || d === 61 ? 2 : 1;
    case 60: // < << <= <<=
      if (d === 60) return e === 61 ? 3 : 2;
      return d === 61 ? 2 : 1;
    case 62: // > >> >>> >= >>= >>>=
      if (d === 62) {
        if (e === 62) return code.charCodeAt(i + 3) === 61 ? 4 : 3;
        return e === 61 ? 3 : 2;
      }
      return d === 61 ? 2 : 1;
    case 37: // % %=
    case 94: // ^ ^=
    case 47: // / /=
      return d === 61 ? 2 : 1;
    default:
      return 1;
  }
}
