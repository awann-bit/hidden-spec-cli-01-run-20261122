// mend — one patch tool for every AI edit format.
//
// Applies an AI-written edit to the tree of text files in the working
// directory, exactly as SPEC.md says: unified diffs (often with wrong line
// numbers), SEARCH/REPLACE blocks, V4A patches and JSON tool calls. Every
// file changes or none does. Node 22, standard library only; run as
// `node main.ts [options] [PATCH]`.
//
// The trial hand-over at the bottom is the kit's: when MAKEFUN_ENV_URL is
// set, runner.ts reads the checks from the env and runs this file on each
// one, without that variable.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A failure that exits 2 with this one line on stdout. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed: exit 1 with `error: <code> <path>`. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC.md section 3): split at \n, one trailing \r off each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (SPEC.md section 3). */
function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Byte order of two paths (UTF-8), for the exit-0 listing. */
function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Trailing spaces and tabs off, for tier 1. */
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
/** Leading and trailing spaces and tabs off, for tier 2. */
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
/** The leading spaces and tabs of a line, for tier 2 re-indenting. */
function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A file as lines: its line break, its lines, and whether it ends with a break (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: '\r\n' | '\n';
  ends: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

/** One line of O against one line of the file at a tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position where O occurs in the file's lines at a tier; occurrences may overlap. */
function occurrences(oldLines: string[], fileLines: string[], tier: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0 || oldLines.length > fileLines.length) return out;
  for (let i = 0; i + oldLines.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      if (!lineEq(oldLines[j]!, fileLines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs, with its positions; null when it occurs at no tier. */
function matchOld(oldLines: string[], fileLines: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrences(oldLines, fileLines, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of N: a context line (the file's own line at this index into O) or a fresh line. */
interface NewLine {
  ctx: number | null;
  text: string;
}

/**
 * The lines that replace the matched ones (SPEC.md section 5). A context
 * line is written as the file's own matched line, never the patch's. At
 * tier 2 every other line is re-indented: the leading spaces and tabs of
 * O's first line are replaced by those of the file's first matched line.
 */
function buildNew(oldLines: string[], fresh: NewLine[], fileLines: string[], at: number, tier: number): string[] {
  if (tier !== 2) {
    return fresh.map((nl) => (nl.ctx === null ? nl.text : fileLines[at + nl.ctx]!));
  }
  const f = leadWs(fileLines[at]!);
  const p = oldLines.length === 0 ? '' : leadWs(oldLines[0]!);
  return fresh.map((nl) => {
    if (nl.ctx !== null) return fileLines[at + nl.ctx]!;
    const t = nl.text;
    if (t === '' || t.trim() === '' || !t.startsWith(p)) return t;
    return f + t.slice(p.length);
  });
}

/**
 * O and N of a hunk or chunk body, in body order. A context line (a line of
 * both O and N) is marked with its index into O; a `+` line is fresh.
 * `\` lines carry no line of their own.
 */
function splitBody(body: string[]): { old: string[]; fresh: NewLine[] } {
  const old: string[] = [];
  const fresh: NewLine[] = [];
  for (const l of body) {
    if (l === '' || l.startsWith(' ')) {
      const t = l === '' ? '' : l.slice(1);
      old.push(t);
      fresh.push({ ctx: old.length - 1, text: t });
    } else if (l.startsWith('-')) {
      old.push(l.slice(1));
    } else if (l.startsWith('+')) {
      fresh.push({ ctx: null, text: l.slice(1) });
    }
  }
  return { old, fresh };
}

/** The tree as the edits leave it: pending changes in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly seen = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, in order, for the exit-0 R lines. */
  readonly moves: { old: string; new: string }[] = [];

  original(p: string): string | null {
    if (!this.seen.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.seen.set(p, v);
    }
    return this.seen.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  /** Record a pending change: a new text, or null for a deletion. */
  set(p: string, text: string | null): void {
    this.now.set(p, text);
  }
}

/** The format of a patch (SPEC.md section 4), or null when none is detected. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** The path after `--- ` / `+++ `: up to the first tab, surrounding spaces removed. */
function headerPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

/** A leading a/ or b/ removed from a path. */
function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** The two paths of a `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function gitPaths(line: string): [string, string] | null {
  const parts = line.slice('diff --git '.length).trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const a = parts[0]!;
  const b = parts[1]!;
  if (!a.startsWith('a/') || !b.startsWith('b/')) return null;
  const x = a.slice(2);
  const y = b.slice(2);
  if (x === '' || y === '') return null;
  return [x, y];
}

interface Hunk {
  start: number;
  body: string[];
}

/** A hunk header `@@ -A[,B] +C[,D] @@`, optionally followed by text; anything else starting with `@@` is a parse error. */
function parseHunkHeader(line: string, n: number): Hunk {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${n}`);
  return { start: Number(m[1]), body: [] };
}

/** Whether a `\` line follows the hunk's last context or `+` line (SPEC.md section 6). */
function backslashAfterLast(body: string[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k += 1) {
    const l = body[k]!;
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) last = k;
  }
  if (last < 0) return false;
  const next = body[last + 1];
  return next !== undefined && next.startsWith('\\');
}

/** One unified section under construction. pairOld/pairNew are undefined when no `---`/`+++` pair names the paths. */
interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | null;
  renameNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The one edit a unified section is (SPEC.md section 6). */
function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.pairOld !== undefined ? sec.pairOld : (sec.renameOld ?? sec.gitOld);
  const newP = sec.pairNew !== undefined ? sec.pairNew : (sec.renameNew ?? sec.gitNew);
  const isCreation = oldP === null || sec.newFile;
  const isDeletion = !isCreation && (newP === null || sec.deletedFile);
  const isMove = !isCreation && !isDeletion && oldP !== null && newP !== null && oldP !== newP;

  return (tree: Tree): void => {
    if (isCreation) {
      const p = newP ?? '';
      if (!safePath(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const l of h.body) {
          if (l.startsWith('+')) plus.push(l.slice(1));
        }
      }
      let noBreak = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
        const h = sec.hunks[hi]!;
        let lastPlus = -1;
        for (let k = 0; k < h.body.length; k += 1) {
          if (h.body[k]!.startsWith('+')) lastPlus = k;
        }
        if (lastPlus >= 0) {
          const next = h.body[lastPlus + 1];
          noBreak = next !== undefined && next.startsWith('\\');
          break;
        }
      }
      tree.set(p, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (isDeletion) {
      const p = oldP ?? '';
      if (!safePath(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) === null) throw new EditFail('missing', p);
      tree.set(p, null);
      return;
    }
    const oldPath = oldP ?? '';
    const newPath = newP ?? oldPath;
    if (!safePath(oldPath)) throw new EditFail('unsafe', oldPath);
    if (isMove && !safePath(newPath)) throw new EditFail('unsafe', newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new EditFail('missing', oldPath);
    if (isMove && tree.get(newPath) !== null) throw new EditFail('exists', newPath);
    const file = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const { old, fresh } = splitBody(h.body);
      if (old.length === 0) {
        const at = Math.min(h.start + d, file.lines.length);
        const atEnd = at === file.lines.length;
        const added = fresh.map((nl) => nl.text);
        file.lines.splice(at, 0, ...added);
        if (atEnd) file.ends = !backslashAfterLast(h.body);
        d += fresh.length;
        continue;
      }
      const m = matchOld(old, file.lines, strict);
      if (m === null) throw new EditFail('no-match', oldPath);
      const target = h.start - 1 + d;
      let pos = m.positions[0]!;
      for (const q of m.positions) {
        if (Math.abs(q - target) < Math.abs(pos - target)) pos = q;
      }
      const replacement = buildNew(old, fresh, file.lines, pos, m.tier);
      const runsToEnd = pos + old.length === file.lines.length;
      file.lines.splice(pos, old.length, ...replacement);
      if (runsToEnd) file.ends = !backslashAfterLast(h.body);
      d += fresh.length - old.length;
    }
    const out = renderFile(file);
    if (isMove) {
      tree.set(newPath, out);
      tree.set(oldPath, null);
      tree.moves.push({ old: oldPath, new: newPath });
    } else {
      tree.set(oldPath, out);
    }
  };
}

/** The edits of a unified diff (SPEC.md section 6). */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let sec: Section | null = null;
  let hasPair = false;
  let hunk: Hunk | null = null;
  let pastHeader = false;

  const endHunk = (): void => {
    if (hunk !== null && sec !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      sec.hunks.push(hunk);
      hunk = null;
    }
  };
  const endSection = (): void => {
    endHunk();
    if (sec !== null) edits.push(sectionEdit(sec, strict));
    sec = null;
    hasPair = false;
    pastHeader = false;
  };
  const startSection = (oldGit: string | null, newGit: string | null): void => {
    sec = { gitOld: oldGit, gitNew: newGit, pairOld: undefined, pairNew: undefined, renameOld: null, renameNew: null, newFile: false, deletedFile: false, hunks: [] };
    hasPair = false;
    pastHeader = false;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (line.startsWith('diff --git ')) {
        endSection();
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        endSection();
        continue;
      }
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        hunk.body.push(line);
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        endHunk();
        hunk = parseHunkHeader(line, i + 1);
        pastHeader = true;
        i += 1;
        continue;
      }
      endHunk();
      continue;
    }
    if (sec === null) {
      if (line.startsWith('diff --git ')) {
        const g = gitPaths(line);
        if (g === null) throw new Exit2(`error: parse ${i + 1}`);
        startSection(g[0], g[1]);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startSection(null, null);
      } else if (line.startsWith('@@')) {
        throw new Exit2(`error: parse ${i + 1}`);
      } else {
        i += 1;
        continue;
      }
    }
    if (!pastHeader) {
      if (line.startsWith('@@')) {
        hunk = parseHunkHeader(line, i + 1);
        pastHeader = true;
        i += 1;
        continue;
      }
      if (line.startsWith('diff --git ')) {
        endSection();
        continue;
      }
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (!hasPair) {
            const o = headerPath(line);
            const n = headerPath(lines[i + 1]!);
            sec!.pairOld = o === '/dev/null' ? null : stripAB(o);
            sec!.pairNew = n === '/dev/null' ? null : stripAB(n);
            hasPair = true;
            i += 2;
            continue;
          }
          endSection();
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        sec!.renameOld = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec!.renameNew = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec!.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec!.deletedFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      endSection();
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      endSection();
      continue;
    }
    if (line.startsWith('@@')) {
      hunk = parseHunkHeader(line, i + 1);
      i += 1;
      continue;
    }
    i += 1;
  }
  endSection();
  return edits;
}

/** One SEARCH/REPLACE block as an edit (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree): void => {
    if (!safePath(path)) throw new EditFail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFail('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditFail('missing', path);
    const file = parseFile(before);
    const m = matchOld(oldLines, file.lines, strict);
    if (m === null) throw new EditFail('no-match', path);
    if (m.positions.length > 1) throw new EditFail('ambiguous', path);
    const pos = m.positions[0]!;
    const fresh: NewLine[] = newLines.map((t) => ({ ctx: null, text: t }));
    const replacement = buildNew(oldLines, fresh, file.lines, pos, m.tier);
    file.lines.splice(pos, oldLines.length, ...replacement);
    tree.set(path, renderFile(file));
  };
}

/** The edits of SEARCH/REPLACE blocks (SPEC.md section 7). */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let k = s - 1; k > prevEnd; k -= 1) {
      const l = lines[k]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let k = s + 1; k < lines.length; k += 1) {
      const l = lines[k]!;
      if (l.trimEnd() === '=======') {
        sep = k;
        break;
      }
      if (l.trimEnd() === '>>>>>>> REPLACE' || l.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let k = sep + 1; k < lines.length; k += 1) {
      const l = lines[k]!;
      if (l.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (l.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srEdit(path, lines.slice(s + 1, sep), lines.slice(sep + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: an optional anchor, its body lines, and whether `*** End of File` ends it. */
interface VChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

/** The first line at or after `from` equal to the anchor, at the first tier with one; -1 when there is none. */
function findAnchor(anchor: string, fileLines: string[], from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < fileLines.length; i += 1) {
      if (lineEq(anchor, fileLines[i]!, tier)) return i;
    }
  }
  return -1;
}

/** The first occurrence of O at or after `from`, at the first tier with one; null when there is none. */
function matchFrom(oldLines: string[], fileLines: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i + oldLines.length <= fileLines.length; i += 1) {
      if (eof && i + oldLines.length !== fileLines.length) continue;
      let ok = true;
      for (let j = 0; j < oldLines.length; j += 1) {
        if (!lineEq(oldLines[j]!, fileLines[i + j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) return { tier, pos: i };
    }
  }
  return null;
}

/** The `*** Move to:` path and the chunks of an Update File section's lines (SPEC.md section 8). */
function parseV4aUpdate(raw: string[], startLine: number): { moveTo: string | null; chunks: VChunk[] } {
  let moveTo: string | null = null;
  let k = 0;
  if (k < raw.length && raw[k]!.startsWith('*** Move to: ')) {
    moveTo = raw[k]!.slice('*** Move to: '.length).trim();
    k += 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let closed = false;
  while (k < raw.length) {
    const l = raw[k]!;
    if (l.startsWith('@@')) {
      cur = { anchor: l.slice(2).trim() || null, body: [], eof: false };
      chunks.push(cur);
      closed = false;
      k += 1;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${startLine + 1 + k}`);
      cur.eof = true;
      closed = true;
      k += 1;
      continue;
    }
    if (l.startsWith('*** Move to: ')) {
      throw new Exit2(`error: parse ${startLine + 1 + k}`);
    }
    if (cur === null) {
      if (chunks.length === 0 && !closed) {
        cur = { anchor: null, body: [], eof: false };
        chunks.push(cur);
      } else {
        throw new Exit2(`error: parse ${startLine + 1 + k}`);
      }
    }
    if (closed) throw new Exit2(`error: parse ${startLine + 1 + k}`);
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      cur.body.push(l);
      k += 1;
      continue;
    }
    throw new Exit2(`error: parse ${startLine + 1 + k}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
  return { moveTo, chunks };
}

function vAddEdit(path: string, addLines: string[]): Edit {
  return (tree: Tree): void => {
    if (!safePath(path)) throw new EditFail('unsafe', path);
    if (tree.get(path) !== null) throw new EditFail('exists', path);
    tree.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
  };
}

function vDeleteEdit(path: string): Edit {
  return (tree: Tree): void => {
    if (!safePath(path)) throw new EditFail('unsafe', path);
    if (tree.get(path) === null) throw new EditFail('missing', path);
    tree.set(path, null);
  };
}

function vUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree: Tree): void => {
    if (!safePath(path)) throw new EditFail('unsafe', path);
    if (moveTo !== null && !safePath(moveTo)) throw new EditFail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new EditFail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFail('exists', moveTo);
    const file = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(ch.anchor, file.lines, cursor, strict);
        if (at < 0) throw new EditFail('no-match', path);
        cursor = at + 1;
      }
      const { old, fresh } = splitBody(ch.body);
      if (old.length === 0) {
        const at = ch.eof ? file.lines.length : cursor;
        const added = fresh.map((nl) => nl.text);
        file.lines.splice(at, 0, ...added);
        cursor = at + added.length;
        continue;
      }
      const m = matchFrom(old, file.lines, cursor, strict, ch.eof);
      if (m === null) throw new EditFail('no-match', path);
      const replacement = buildNew(old, fresh, file.lines, m.pos, m.tier);
      file.lines.splice(m.pos, old.length, ...replacement);
      cursor = m.pos + replacement.length;
    }
    const out = renderFile(file);
    if (moveTo !== null) {
      tree.set(moveTo, out);
      tree.set(path, null);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.set(path, out);
    }
  };
}

/** The edits of a V4A patch (SPEC.md section 8). */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const raw: string[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        raw.push(lines[j]!);
        j += 1;
      }
      while (raw.length > 0 && isBlank(raw[raw.length - 1]!)) raw.pop();
      const addLines: string[] = [];
      for (let k = 0; k < raw.length; k += 1) {
        const l = raw[k]!;
        if (l.startsWith('+')) addLines.push(l.slice(1));
        else if (l === '') addLines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(vAddEdit(p, addLines));
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && isBlank(lines[j]!)) j += 1;
      edits.push(vDeleteEdit(p));
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const startLine = i + 1;
      const raw: string[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        raw.push(lines[j]!);
        j += 1;
      }
      while (raw.length > 0 && isBlank(raw[raw.length - 1]!)) raw.pop();
      const { moveTo, chunks } = parseV4aUpdate(raw, startLine);
      edits.push(vUpdateEdit(p, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree: Tree): void => {
      if (!safePath(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree: Tree): void => {
      if (!safePath(p)) throw new EditFail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const fold = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = fold(before);
      const old = fold(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + fold(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree: Tree): void => {
      if (!safePath(p)) throw new EditFail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      const file = parseFile(before);
      if (lineNo < 0 || lineNo > file.lines.length) throw new EditFail('no-match', p);
      file.lines.splice(lineNo, 0, ...add);
      tree.set(p, renderFile(file));
    };
  }
  return null;
}

/** The edits of a JSON patch: one array, or one edit object a line (SPEC.md section 9). */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const savedNow = new Map(tree.now);
    const savedMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of savedNow) tree.now.set(k, v);
      tree.moves.length = savedMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; text: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) rows.push({ key: p, text: `A ${p}` });
    else if (now === null) rows.push({ key: p, text: `D ${p}` });
    else rows.push({ key: p, text: `M ${p}` });
  }
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) {
      const di = rows.findIndex((r) => r.text === `D ${m.old}`);
      const ai = rows.findIndex((r) => r.text === `A ${m.new}`);
      if (di >= 0) rows.splice(di, 1);
      if (ai >= 0) rows.splice(ai, 1);
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
    }
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
