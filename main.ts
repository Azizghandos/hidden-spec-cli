// mend: one patch tool for every AI edit format.
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

class ParseErr extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

type EditResult = { ok: true } | { ok: false; code: string; path: string };
interface Ctx { strict: boolean }
interface Edit { run(t: Tree, ctx: Ctx): EditResult }

interface FileDoc { lines: string[]; eol: string; trail: boolean }

function parseDoc(text: string): FileDoc {
  if (text === '') return { lines: [], eol: '\n', trail: false };
  const nl = text.indexOf('\n');
  const eol = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const trail = text.endsWith(eol);
  const lines = text.split(eol);
  if (trail) lines.pop();
  return { lines, eol, trail };
}

function renderDoc(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.eol) + (d.trail ? d.eol : '');
}

function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) if (seg === '' || seg === '.' || seg === '..') return false;
  return true;
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    let good = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineEq(lines[i + k], o[k], tier)) { good = false; break; }
    }
    if (good) out.push(i);
  }
  return out;
}

function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface NewLine { text: string; oIdx: number }

function mapNew(n: NewLine[], fileLines: string[], pos: number, o: string[], tier: number): string[] {
  const out: string[] = [];
  const f = pos < fileLines.length ? leadWs(fileLines[pos]) : '';
  const p = o.length > 0 ? leadWs(o[0]) : '';
  for (const e of n) {
    if (e.oIdx >= 0) {
      out.push(fileLines[pos + e.oIdx]);
    } else {
      let t = e.text;
      if (tier === 2 && t !== '' && trimBothWs(t) !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

class Tree {
  cur = new Map<string, string | null>();
  orig = new Map<string, string | null>();
  moves: { old: string; nw: string }[] = [];

  private diskPath(p: string): string { return join(process.cwd(), ...p.split('/')); }

  private disk(p: string): string | null {
    try {
      const f = this.diskPath(p);
      if (statSync(f).isFile()) return readFileSync(f, 'utf8');
    } catch { /* absent */ }
    return null;
  }

  get(p: string): string | null {
    if (this.cur.has(p)) return this.cur.get(p) as string | null;
    const v = this.disk(p);
    this.cur.set(p, v);
    this.orig.set(p, v);
    return v;
  }

  exists(p: string): boolean {
    if (this.cur.has(p)) return this.cur.get(p) !== null;
    return existsSync(this.diskPath(p));
  }

  set(p: string, v: string | null): void {
    if (!this.orig.has(p)) this.orig.set(p, this.disk(p));
    this.cur.set(p, v);
  }
}

interface Cli { format: string; check: boolean; strict: boolean; patch: string | null }

function parseArgs(argv: string[]): Cli | null {
  let format = 'auto';
  let check = false;
  let strict = false;
  let formatSeen = false;
  let checkSeen = false;
  let strictSeen = false;
  let endOpts = false;
  const positional: string[] = [];
  for (const a of argv) {
    if (!endOpts && a === '--') { endOpts = true; continue; }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (checkSeen) return null;
        checkSeen = true;
        check = true;
      } else if (a === '--strict') {
        if (strictSeen) return null;
        strictSeen = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (formatSeen) return null;
        formatSeen = true;
        const v = a.slice('--format='.length);
        if (v !== 'auto' && v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json') return null;
        format = v;
      } else {
        return null;
      }
    } else {
      positional.push(a);
      if (positional.length > 1) return null;
    }
  }
  return { format, check, strict, patch: positional.length > 0 ? positional[0] : null };
}

function patchLines(text: string): string[] {
  if (text === '') return [];
  const ls = text.split('\n');
  if (text.endsWith('\n')) ls.pop();
  for (let i = 0; i < ls.length; i++) if (ls[i].endsWith('\r')) ls[i] = ls[i].slice(0, -1);
  return ls;
}

function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') { first = i; break; }
  }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  for (let i = 0; i < lines.length; i++) {
    if (trimEndWs(lines[i]) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

function splitNewStr(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (s.endsWith('\n')) parts.pop();
  for (let i = 0; i < parts.length; i++) if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1);
  return parts;
}

function validateJsonEdit(obj: unknown, lineNo: number): Edit {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new ParseErr(lineNo);
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') throw new ParseErr(lineNo);
  if (typeof o.command !== 'string') throw new ParseErr(lineNo);
  const path = o.path as string;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseErr(lineNo);
    const text = o.file_text as string;
    return {
      run(t: Tree): EditResult {
        if (!isSafe(path)) return { ok: false, code: 'unsafe', path };
        if (t.exists(path)) return { ok: false, code: 'exists', path };
        t.set(path, text);
        return { ok: true };
      },
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || (o.old_str as string) === '') throw new ParseErr(lineNo);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseErr(lineNo);
    const oldStr = o.old_str as string;
    const newStr = (o.new_str as string | undefined) ?? '';
    return {
      run(t: Tree): EditResult {
        if (!isSafe(path)) return { ok: false, code: 'unsafe', path };
        if (!t.exists(path)) return { ok: false, code: 'missing', path };
        const text = t.get(path) as string;
        const crlf = parseDoc(text).eol === '\r\n';
        let hay = text;
        let oldS = oldStr;
        let newS = newStr;
        if (crlf) {
          hay = text.replace(/\r\n/g, '\n');
          oldS = oldStr.replace(/\r\n/g, '\n');
          newS = newStr.replace(/\r\n/g, '\n');
        }
        let count = 0;
        let firstIdx = -1;
        let idx = 0;
        for (;;) {
          const p = hay.indexOf(oldS, idx);
          if (p === -1) break;
          if (firstIdx === -1) firstIdx = p;
          count += 1;
          idx = p + 1;
        }
        if (count === 0) return { ok: false, code: 'no-match', path };
        if (count > 1) return { ok: false, code: 'ambiguous', path };
        const res = hay.slice(0, firstIdx) + newS + hay.slice(firstIdx + oldS.length);
        t.set(path, crlf ? res.replace(/\n/g, '\r\n') : res);
        return { ok: true };
      },
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throw new ParseErr(lineNo);
    if (typeof o.new_str !== 'string') throw new ParseErr(lineNo);
    const lineNo2 = o.insert_line as number;
    const newStr = o.new_str as string;
    return {
      run(t: Tree): EditResult {
        if (!isSafe(path)) return { ok: false, code: 'unsafe', path };
        if (!t.exists(path)) return { ok: false, code: 'missing', path };
        const doc = parseDoc(t.get(path) as string);
        if (lineNo2 < 0 || lineNo2 > doc.lines.length) return { ok: false, code: 'no-match', path };
        const lines = [...doc.lines];
        lines.splice(lineNo2, 0, ...splitNewStr(newStr));
        t.set(path, renderDoc({ lines, eol: doc.eol, trail: doc.trail }));
        return { ok: true };
      },
    };
  }
  throw new ParseErr(lineNo);
}

function parseJson(lines: string[], rawText: string): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') { first = i; break; }
  }
  if (first === -1) throw new ParseErr(1);
  const edits: Edit[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(rawText);
    } catch {
      throw new ParseErr(first + 1);
    }
    if (!Array.isArray(arr)) throw new ParseErr(first + 1);
    for (const el of arr) edits.push(validateJsonEdit(el, first + 1));
    if (edits.length === 0) throw new ParseErr(1);
    return edits;
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      throw new ParseErr(i + 1);
    }
    edits.push(validateJsonEdit(obj, i + 1));
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

function makeSREdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return {
    run(t: Tree, ctx: Ctx): EditResult {
      if (!isSafe(path)) return { ok: false, code: 'unsafe', path };
      if (oldLines.length === 0) {
        if (t.exists(path)) return { ok: false, code: 'exists', path };
        t.set(path, renderDoc({ lines: [...newLines], eol: '\n', trail: newLines.length > 0 }));
        return { ok: true };
      }
      if (!t.exists(path)) return { ok: false, code: 'missing', path };
      const doc = parseDoc(t.get(path) as string);
      const found = findTier(doc.lines, oldLines, ctx.strict, 0);
      if (found === null) return { ok: false, code: 'no-match', path };
      if (found.occ.length > 1) return { ok: false, code: 'ambiguous', path };
      const pos = found.occ[0];
      const n: NewLine[] = newLines.map((text) => ({ text, oIdx: -1 }));
      const mapped = mapNew(n, doc.lines, pos, oldLines, found.tier);
      const lines = [...doc.lines];
      lines.splice(pos, oldLines.length, ...mapped);
      t.set(path, renderDoc({ lines, eol: doc.eol, trail: doc.trail }));
      return { ok: true };
    },
  };
}

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (trimEndWs(lines[i]) !== '<<<<<<< SEARCH') { i += 1; continue; }
    const sIdx = i;
    let path: string | null = null;
    for (let j = sIdx - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseErr(sIdx + 1);
    }
    let eq = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      const t = trimEndWs(lines[j]);
      if (t === '=======') { eq = j; break; }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') throw new ParseErr(sIdx + 1);
    }
    if (eq === -1) throw new ParseErr(sIdx + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (trimEndWs(lines[j]) === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep === -1) throw new ParseErr(sIdx + 1);
    const oldLines = lines.slice(sIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(makeSREdit(path, oldLines, newLines));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

interface HunkItem { kind: 'ctx' | 'del' | 'add'; text: string; noNL?: boolean }
interface UniHunk { a: number; items: HunkItem[] }
interface UniSection {
  pairOld: string | null; pairNew: string | null;
  renFrom: string | null; renTo: string | null;
  diffOld: string | null; diffNew: string | null;
  newFile: boolean; delFile: boolean; hasPair: boolean;
  hunks: UniHunk[];
}

function headerPath(line: string): string {
  const p = line.slice(4).split('\t')[0].trim();
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function splitHunk(items: HunkItem[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      const idx = o.length;
      o.push(it.text);
      n.push({ text: it.text, oIdx: idx });
    } else if (it.kind === 'del') {
      o.push(it.text);
    } else {
      n.push({ text: it.text, oIdx: -1 });
    }
  }
  return { o, n };
}

function lastCtxOrAddNoNL(items: HunkItem[]): boolean {
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k].kind === 'ctx' || items[k].kind === 'add') return items[k].noNL === true;
  }
  return false;
}

function lastAddNoNL(hunks: UniHunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const items = hunks[h].items;
    for (let k = items.length - 1; k >= 0; k--) {
      if (items[k].kind === 'add') return items[k].noNL === true;
    }
  }
  return false;
}

function applyHunks(doc: FileDoc, hunks: UniHunk[], strict: boolean): { ok: boolean; doc: FileDoc } {
  let lines = [...doc.lines];
  let trail = doc.trail;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitHunk(h.items);
    const noNL = lastCtxOrAddNoNL(h.items);
    if (o.length === 0) {
      const rawIdx = h.a + d;
      const idx = Math.min(Math.max(rawIdx, 0), lines.length);
      const atEnd = rawIdx >= lines.length;
      const mapped = mapNew(n, lines, idx, o, 0);
      lines.splice(idx, 0, ...mapped);
      if (atEnd) trail = !noNL;
      d += n.length;
    } else {
      const found = findTier(lines, o, strict, 0);
      if (found === null) return { ok: false, doc };
      const target = h.a - 1 + d;
      let best = found.occ[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) { best = p; bestDist = dist; }
      }
      const pos = best;
      const mapped = mapNew(n, lines, pos, o, found.tier);
      const atEnd = pos + o.length === lines.length;
      lines.splice(pos, o.length, ...mapped);
      if (atEnd) trail = !noNL;
      d += n.length - o.length;
    }
  }
  return { ok: true, doc: { lines, eol: doc.eol, trail } };
}

function makeUnifiedEdit(s: UniSection): Edit {
  return {
    run(t: Tree, ctx: Ctx): EditResult {
      const oldRaw = s.pairOld ?? s.renFrom ?? s.diffOld;
      const newRaw = s.pairNew ?? s.renTo ?? s.diffNew;
      const oldP = oldRaw === null || oldRaw === '/dev/null' ? null : oldRaw;
      const newP = newRaw === null || newRaw === '/dev/null' ? null : newRaw;
      const isCreate = oldP === null || s.newFile;
      const isDelete = newP === null || s.delFile;
      for (const p of [oldP, newP]) {
        if (p !== null && !isSafe(p)) return { ok: false, code: 'unsafe', path: p };
      }
      if (isCreate && newP !== null) {
        if (t.exists(newP)) return { ok: false, code: 'exists', path: newP };
        const plus: string[] = [];
        for (const h of s.hunks) for (const it of h.items) if (it.kind === 'add') plus.push(it.text);
        t.set(newP, renderDoc({ lines: plus, eol: '\n', trail: !lastAddNoNL(s.hunks) }));
        return { ok: true };
      }
      if (isDelete && oldP !== null) {
        if (!t.exists(oldP)) return { ok: false, code: 'missing', path: oldP };
        t.set(oldP, null);
        return { ok: true };
      }
      if (oldP !== null && newP !== null && oldP !== newP) {
        if (!t.exists(oldP)) return { ok: false, code: 'missing', path: oldP };
        if (t.exists(newP)) return { ok: false, code: 'exists', path: newP };
        const doc = parseDoc(t.get(oldP) as string);
        const res = applyHunks(doc, s.hunks, ctx.strict);
        if (!res.ok) return { ok: false, code: 'no-match', path: oldP };
        t.set(newP, renderDoc(res.doc));
        t.set(oldP, null);
        t.moves.push({ old: oldP, nw: newP });
        return { ok: true };
      }
      if (oldP !== null) {
        if (!t.exists(oldP)) return { ok: false, code: 'missing', path: oldP };
        const doc = parseDoc(t.get(oldP) as string);
        const res = applyHunks(doc, s.hunks, ctx.strict);
        if (!res.ok) return { ok: false, code: 'no-match', path: oldP };
        t.set(oldP, renderDoc(res.doc));
        return { ok: true };
      }
      return { ok: false, code: 'missing', path: '' };
    },
  };
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  const blankSection = (): UniSection => ({
    pairOld: null, pairNew: null, renFrom: null, renTo: null,
    diffOld: null, diffNew: null, newFile: false, delFile: false,
    hasPair: false, hunks: [],
  });
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const L = lines[i];
    if (L.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(L) ?? /^diff --git a\/(.+) b\/(.+)$/.exec(L);
      if (m === null) throw new ParseErr(i + 1);
      cur = blankSection();
      cur.diffOld = m[1];
      cur.diffNew = m[2];
      sections.push(cur);
      i += 1;
      continue;
    }
    if (L.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      if (cur !== null && !cur.hasPair && cur.hunks.length === 0) {
        cur.pairOld = headerPath(L);
        cur.pairNew = headerPath(lines[i + 1]);
        cur.hasPair = true;
      } else {
        cur = blankSection();
        cur.pairOld = headerPath(L);
        cur.pairNew = headerPath(lines[i + 1]);
        cur.hasPair = true;
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (L.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(L);
      if (m === null || cur === null) throw new ParseErr(i + 1);
      const hunk: UniHunk = { a: parseInt(m[1], 10), items: [] };
      cur.hunks.push(hunk);
      i += 1;
      const body: string[] = [];
      while (i < n) {
        const B = lines[i];
        if (B.startsWith('diff --git ')) break;
        if (B.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) break;
        if (B === '' || B[0] === ' ' || B[0] === '-' || B[0] === '+' || B[0] === '\\') { body.push(B); i += 1; }
        else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      for (const raw of body) {
        if (raw[0] === '\\') {
          const prev = hunk.items[hunk.items.length - 1];
          if (prev !== undefined) prev.noNL = true;
        } else if (raw === '') {
          hunk.items.push({ kind: 'ctx', text: '' });
        } else if (raw[0] === ' ') {
          hunk.items.push({ kind: 'ctx', text: raw.slice(1) });
        } else if (raw[0] === '-') {
          hunk.items.push({ kind: 'del', text: raw.slice(1) });
        } else {
          hunk.items.push({ kind: 'add', text: raw.slice(1) });
        }
      }
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (L.startsWith('--- ')) throw new ParseErr(i + 2);
      if (L.startsWith('rename from ')) cur.renFrom = L.slice('rename from '.length).trim();
      else if (L.startsWith('rename to ')) cur.renTo = L.slice('rename to '.length).trim();
      else if (L === 'new file mode' || L.startsWith('new file mode ')) cur.newFile = true;
      else if (L === 'deleted file mode' || L.startsWith('deleted file mode ')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new ParseErr(1);
  return sections.map((s) => makeUnifiedEdit(s));
}

interface VChunk { anchor: string | null; eof: boolean; items: HunkItem[] }

function makeV4Add(path: string, fileLines: string[]): Edit {
  return {
    run(t: Tree): EditResult {
      if (!isSafe(path)) return { ok: false, code: 'unsafe', path };
      if (t.exists(path)) return { ok: false, code: 'exists', path };
      t.set(path, renderDoc({ lines: [...fileLines], eol: '\n', trail: fileLines.length > 0 }));
      return { ok: true };
    },
  };
}

function makeV4Del(path: string): Edit {
  return {
    run(t: Tree): EditResult {
      if (!isSafe(path)) return { ok: false, code: 'unsafe', path };
      if (!t.exists(path)) return { ok: false, code: 'missing', path };
      t.set(path, null);
      return { ok: true };
    },
  };
}

function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = cursor; i < lines.length; i++) {
      if (lineEq(lines[i], anchor, tier)) return i;
    }
  }
  return -1;
}

function makeV4Update(path: string, moveTo: string | null, chunks: VChunk[]): Edit {
  return {
    run(t: Tree, ctx: Ctx): EditResult {
      if (!isSafe(path)) return { ok: false, code: 'unsafe', path };
      if (moveTo !== null && !isSafe(moveTo)) return { ok: false, code: 'unsafe', path: moveTo };
      if (!t.exists(path)) return { ok: false, code: 'missing', path };
      if (moveTo !== null && t.exists(moveTo)) return { ok: false, code: 'exists', path: moveTo };
      const doc = parseDoc(t.get(path) as string);
      let lines = [...doc.lines];
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null && ch.anchor !== '') {
          const ai = findAnchor(lines, ch.anchor, cursor, ctx.strict);
          if (ai === -1) return { ok: false, code: 'no-match', path };
          cursor = ai + 1;
        }
        const { o, n } = splitHunk(ch.items);
        if (o.length === 0) {
          const idx = ch.eof ? lines.length : cursor;
          const mapped = mapNew(n, lines, idx, o, 0);
          lines.splice(idx, 0, ...mapped);
          cursor = idx + mapped.length;
        } else {
          const found = findTier(lines, o, ctx.strict, cursor);
          if (found === null) return { ok: false, code: 'no-match', path };
          let pos = -1;
          for (const p of found.occ) {
            if (ch.eof && p + o.length !== lines.length) continue;
            pos = p;
            break;
          }
          if (pos === -1) return { ok: false, code: 'no-match', path };
          const mapped = mapNew(n, lines, pos, o, found.tier);
          lines.splice(pos, o.length, ...mapped);
          cursor = pos + mapped.length;
        }
      }
      const out = renderDoc({ lines, eol: doc.eol, trail: doc.trail });
      if (moveTo !== null) {
        t.set(moveTo, out);
        t.set(path, null);
        t.moves.push({ old: path, nw: moveTo });
      } else {
        t.set(path, out);
      }
      return { ok: true };
    },
  };
}

function parseV4Update(path: string, body: string[], bodyStart: number, updateLine: number): Edit {
  let moveTo: string | null = null;
  let k = 0;
  if (body.length > 0 && body[0].startsWith('*** Move to: ')) {
    moveTo = body[0].slice('*** Move to: '.length).trim();
    k = 1;
  }
  const chunks: VChunk[] = [];
  let curChunk: VChunk | null = null;
  let endedByEof = false;
  for (; k < body.length; k++) {
    const B = body[k];
    const lineNo = bodyStart + k + 1;
    if (B.startsWith('@@')) {
      curChunk = { anchor: B.slice(2).trim(), eof: false, items: [] };
      if (curChunk.anchor === '') curChunk.anchor = null;
      chunks.push(curChunk);
      endedByEof = false;
    } else if (B === '*** End of File') {
      if (curChunk === null) throw new ParseErr(lineNo);
      curChunk.eof = true;
      endedByEof = true;
      curChunk = null;
    } else if (B === '' || B[0] === ' ' || B[0] === '-' || B[0] === '+') {
      if (curChunk === null) {
        if (chunks.length === 0 && !endedByEof) {
          curChunk = { anchor: null, eof: false, items: [] };
          chunks.push(curChunk);
        } else {
          throw new ParseErr(lineNo);
        }
      }
      if (B === '') curChunk.items.push({ kind: 'ctx', text: '' });
      else if (B[0] === ' ') curChunk.items.push({ kind: 'ctx', text: B.slice(1) });
      else if (B[0] === '-') curChunk.items.push({ kind: 'del', text: B.slice(1) });
      else curChunk.items.push({ kind: 'add', text: B.slice(1) });
    } else {
      throw new ParseErr(lineNo);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new ParseErr(updateLine);
  return makeV4Update(path, moveTo, chunks);
}

function parseV4a(lines: string[]): Edit[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) throw new ParseErr(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && lines[i].trim() === '') i += 1;
    if (i >= last) break;
    const L = lines[i];
    let kind: 'add' | 'del' | 'upd' | null = null;
    let path = '';
    if (L.startsWith('*** Add File: ')) { kind = 'add'; path = L.slice('*** Add File: '.length).trim(); }
    else if (L.startsWith('*** Delete File: ')) { kind = 'del'; path = L.slice('*** Delete File: '.length).trim(); }
    else if (L.startsWith('*** Update File: ')) { kind = 'upd'; path = L.slice('*** Update File: '.length).trim(); }
    else throw new ParseErr(i + 1);
    const startLine = i + 1;
    i += 1;
    const bodyStart = i;
    while (i < last) {
      const B = lines[i];
      if (B.startsWith('*** Add File: ') || B.startsWith('*** Delete File: ') || B.startsWith('*** Update File: ')) break;
      i += 1;
    }
    const body = lines.slice(bodyStart, i);
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
    if (kind === 'add') {
      const fl: string[] = [];
      for (let k = 0; k < body.length; k++) {
        const b = body[k];
        if (b === '') fl.push('');
        else if (b[0] === '+') fl.push(b.slice(1));
        else throw new ParseErr(bodyStart + k + 1);
      }
      edits.push(makeV4Add(path, fl));
    } else if (kind === 'del') {
      for (let k = 0; k < body.length; k++) {
        if (body[k].trim() !== '') throw new ParseErr(bodyStart + k + 1);
      }
      edits.push(makeV4Del(path));
    } else {
      edits.push(parseV4Update(path, body, bodyStart, startLine));
    }
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

function main(): void {
  const cli = parseArgs(process.argv.slice(2));
  if (cli === null) {
    process.stdout.write('error: usage\n');
    process.exitCode = 2;
    return;
  }
  let patchText: string;
  if (cli.patch === null || cli.patch === '-') {
    try {
      patchText = readFileSync(0, 'utf8');
    } catch {
      patchText = '';
    }
  } else {
    try {
      patchText = readFileSync(join(process.cwd(), ...cli.patch.split('/')), 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      process.exitCode = 2;
      return;
    }
  }
  const lines = patchLines(patchText);
  let format = cli.format;
  if (format === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) {
      process.stdout.write('error: format\n');
      process.exitCode = 2;
      return;
    }
    format = detected;
  }
  let edits: Edit[];
  try {
    if (format === 'unified') edits = parseUnified(lines);
    else if (format === 'search-replace') edits = parseSearchReplace(lines);
    else if (format === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(lines, patchText);
  } catch (e) {
    if (e instanceof ParseErr) {
      process.stdout.write(`error: parse ${e.line}\n`);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  const tree = new Tree();
  const ctx: Ctx = { strict: cli.strict };
  const failures: { code: string; path: string }[] = [];
  for (const e of edits) {
    const snapshot = new Map(tree.cur);
    const movesBefore = tree.moves.length;
    const r = e.run(tree, ctx);
    if (!r.ok) {
      tree.cur = snapshot;
      tree.moves.length = movesBefore;
      failures.push({ code: r.code, path: r.path });
    }
  }
  if (failures.length > 0) {
    const outLines = failures.map((f) => `error: ${f.code} ${f.path}`);
    outLines.push(`failed: ${failures.length} of ${edits.length} edits`);
    process.stdout.write(outLines.join('\n') + '\n');
    process.exitCode = 1;
    return;
  }
  const changed: { sortKey: string; line: string }[] = [];
  const skip = new Set<string>();
  for (const m of tree.moves) {
    const o0 = tree.orig.get(m.old);
    const o1 = tree.cur.get(m.old);
    const n0 = tree.orig.get(m.nw);
    const n1 = tree.cur.get(m.nw);
    const oldGone = o0 !== undefined && o0 !== null && (o1 === undefined || o1 === null);
    const newHere = (n0 === undefined || n0 === null) && n1 !== undefined && n1 !== null;
    if (oldGone && newHere) {
      changed.push({ sortKey: m.nw, line: `R ${m.old} -> ${m.nw}` });
      skip.add(m.old);
      skip.add(m.nw);
    }
  }
  const keys = new Set<string>([...tree.orig.keys(), ...tree.cur.keys()]);
  for (const p of keys) {
    if (skip.has(p)) continue;
    const a = tree.orig.get(p) ?? null;
    const b = tree.cur.get(p) ?? null;
    if (a === b) continue;
    if (a === null) changed.push({ sortKey: p, line: `A ${p}` });
    else if (b === null) changed.push({ sortKey: p, line: `D ${p}` });
    else changed.push({ sortKey: p, line: `M ${p}` });
  }
  changed.sort((x, y) => Buffer.compare(Buffer.from(x.sortKey, 'utf8'), Buffer.from(y.sortKey, 'utf8')));
  const outLines = changed.map((c) => c.line);
  outLines.push(`ok: ${changed.length} ${changed.length === 1 ? 'file' : 'files'}`);
  if (!cli.check) {
    for (const p of keys) {
      const a = tree.orig.get(p) ?? null;
      const b = tree.cur.get(p) ?? null;
      if (a === b) continue;
      const f = join(process.cwd(), ...p.split('/'));
      if (b === null) {
        try { unlinkSync(f); } catch { /* already gone */ }
      } else {
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, b, 'utf8');
      }
    }
  }
  process.stdout.write(outLines.join('\n') + '\n');
  process.exitCode = 0;
}

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  main();
}
