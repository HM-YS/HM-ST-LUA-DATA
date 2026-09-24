#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(process.cwd(), 'data');
const SOURCE_DEFAULT = 'games_source.json';

const TMP_GAMES = path.join(DATA_DIR, '.games.json.tmp');
const TMP_DLC = path.join(DATA_DIR, '.games_dlc.json.tmp');

const OUT_GAMES = path.join(DATA_DIR, 'games.json');
const OUT_DLC = path.join(DATA_DIR, 'games_dlc.json');
const OUT_VERSION = path.join(DATA_DIR, 'version.json');

const NUMERIC_RE = /^\d+$/;
const REPR_RE =
  /^\s*\{\s*'name'\s*:\s*(?:"([^"]*)"|'(.*)')\s*,\s*'header_image'\s*:\s*(?:"[^"]*"|'(?:\\.|[^'])*')\s*\}\s*$/;
const UNESCAPE_RE = /\\(['"\\])/g;
const LINE_TERMINATOR_RE = /[\u2028\u2029]/g;

function cleanName(s) {
  return s.replace(LINE_TERMINATOR_RE, ' ');
}

function sha256hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function fail(msg) {
  console.error('ERROR: ' + msg);
  cleanupTmp();
  process.exit(1);
}

function cleanupTmp() {
  for (const f of [TMP_GAMES, TMP_DLC]) {
    try {
      fs.unlinkSync(f);
    } catch (_) {}
  }
}

function parseRepr(value) {
  const m = REPR_RE.exec(value);
  if (!m) return null;

  const name = (m[1] !== undefined ? m[1] : m[2])
    .replace(UNESCAPE_RE, '$1');

  return { name: cleanName(name) };
}

function buildDlcEntry(val, backfill) {
  const out = {};

  // 输出字段统一使用短键：name -> n
  if (backfill && typeof backfill.n === 'string') {
    out.n = cleanName(backfill.n);
  }

  let extracted = null;

  if (typeof val === 'string') {
    extracted = parseRepr(val);
    if (!extracted) extracted = { name: val };
  } else if (val !== null && typeof val === 'object') {
    extracted = {};
    if (typeof val.name === 'string') extracted.name = val.name;
    if (Object.keys(extracted).length === 0) extracted = null;
  }

  if (extracted && extracted.name) {
    out.n = cleanName(extracted.name);
  }

  return out;
}

function toSortedObj(map) {
  const keys = Array.from(map.keys()).sort(
    (a, b) => Number(a) - Number(b)
  );

  const out = {};
  for (const k of keys) out[k] = map.get(k);

  return out;
}

function main() {
  const sourcePath = process.argv[2] || SOURCE_DEFAULT;

  let list;

  try {
    list = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  } catch (e) {
    fail(`cannot read/parse source "${sourcePath}": ${e.message}`);
  }

  if (!Array.isArray(list)) fail('source top-level must be an array');
  if (list.length === 0) fail('source array is empty');

  const backfill = new Map();

  for (const e of list) {
    if (!e || typeof e !== 'object') continue;

    const id =
      e.appid === undefined || e.appid === null
        ? null
        : String(e.appid);

    if (!id || !NUMERIC_RE.test(id)) continue;
    if (typeof e.type !== 'string' || e.type.toLowerCase() !== 'dlc') continue;

    const info = {};
    if (typeof e.name === 'string') info.n = e.name;

    backfill.set(id, info);
  }

  const gamesOut = new Map();

  for (const e of list) {
    if (!e || typeof e !== 'object') continue;

    const id =
      e.appid === undefined || e.appid === null
        ? null
        : String(e.appid);

    if (!id || !NUMERIC_RE.test(id)) continue;

    const g = {};

    // games.json 字段压缩：
    // name -> n
    // type -> t
    // drm -> d, boolean -> 0/1
    // nsfw -> f, boolean -> 0/1
    // added_date -> at
    // updated_date -> ut
    if (typeof e.name === 'string') g.n = cleanName(e.name);
    if (typeof e.type === 'string') g.t = e.type.toLowerCase();
    if (typeof e.drm === 'boolean') g.d = e.drm ? 1 : 0;
    if (typeof e.nsfw === 'boolean') g.f = e.nsfw ? 1 : 0;
    if (typeof e.added_date === 'string') g.at = e.added_date;
    if (typeof e.updated_date === 'string') g.ut = e.updated_date;

    gamesOut.set(id, g);
  }

  const dlcOut = new Map();
  let dlcCount = 0;

  for (const e of list) {
    if (!e || typeof e !== 'object') continue;

    const id =
      e.appid === undefined || e.appid === null
        ? null
        : String(e.appid);

    if (!id || !NUMERIC_RE.test(id)) continue;

    const d = e.dlc;
    if (d === undefined || d === null) continue;

    let children = null;

    if (Array.isArray(d)) {
      if (d.length === 0) continue;

      children = new Map();

      for (const item of d) {
        const cid =
          typeof item === 'number'
            ? String(item)
            : typeof item === 'string' && NUMERIC_RE.test(item)
              ? item
              : null;

        if (cid === null) continue;

        children.set(cid, buildDlcEntry(null, backfill.get(cid)));
      }
    } else if (typeof d === 'object') {
      if (Object.keys(d).length === 0) continue;

      children = new Map();

      for (const [cid, val] of Object.entries(d)) {
        if (!NUMERIC_RE.test(cid)) continue;

        children.set(cid, buildDlcEntry(val, backfill.get(cid)));
      }
    } else {
      continue;
    }

    if (children.size === 0) continue;

    dlcCount += children.size;
    dlcOut.set(id, children);
  }

  const gamesJson = JSON.stringify(toSortedObj(gamesOut));

  const dlcSorted = new Map();
  for (const [parent, children] of dlcOut) {
    dlcSorted.set(parent, toSortedObj(children));
  }

  const dlcJson = JSON.stringify(toSortedObj(dlcSorted));

  const gamesHash = sha256hex(gamesJson);
  const dlcHash = sha256hex(dlcJson);
  const gamesCount = gamesOut.size;

  let old = null;

  try {
    const v = JSON.parse(fs.readFileSync(OUT_VERSION, 'utf8'));

    if (
      v &&
      typeof v === 'object' &&
      Number.isFinite(v.games_count) &&
      Number.isFinite(v.dlc_count)
    ) {
      old = v;
    }
  } catch (_) {}

  let result;

  if (!old) {
    result = 'FIRST_RUN';
  } else if (
    old.games_sha256 === gamesHash &&
    old.games_dlc_sha256 === dlcHash
  ) {
    let diskOk = true;

    try {
      diskOk =
        sha256hex(fs.readFileSync(OUT_GAMES, 'utf8')) === gamesHash &&
        sha256hex(fs.readFileSync(OUT_DLC, 'utf8')) === dlcHash;
    } catch (_) {
      diskOk = false;
    }

    result = diskOk ? 'NO_CHANGE' : 'CHANGED';
  } else {
    result = 'CHANGED';
  }

  if (result === 'CHANGED' && old) {
    if (
      gamesCount < old.games_count * 0.5 ||
      dlcCount < old.dlc_count * 0.5
    ) {
      fail(
        `upstream data anomaly: games ${old.games_count} -> ${gamesCount}, ` +
        `dlc ${old.dlc_count} -> ${dlcCount} (drop >50%, refusing to write)`
      );
    }
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  fs.writeFileSync(TMP_GAMES, gamesJson, 'utf8');
  fs.writeFileSync(TMP_DLC, dlcJson, 'utf8');

  if (result === 'NO_CHANGE') {
    cleanupTmp();
    console.log('RESULT=NO_CHANGE');
    console.log(`games_count=${gamesCount} dlc_count=${dlcCount}`);
    return;
  }

  fs.renameSync(TMP_GAMES, OUT_GAMES);
  fs.renameSync(TMP_DLC, OUT_DLC);

  const nowSec = Math.floor(Date.now() / 1000);

  const version = {
    version: nowSec,
    updated_at: new Date(nowSec * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z'),
    games_count: gamesCount,
    dlc_count: dlcCount,
    games_sha256: gamesHash,
    games_dlc_sha256: dlcHash,
  };

  fs.writeFileSync(
    OUT_VERSION,
    JSON.stringify(version),
    'utf8'
  );

  console.log(`RESULT=${result}`);
  console.log(`games_count=${gamesCount} dlc_count=${dlcCount}`);
}

try {
  main();
} catch (e) {
  fail(e && e.stack ? e.stack : String(e));
}
