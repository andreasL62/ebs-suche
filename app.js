'use strict';
/* EBS Zeichnungssuche – Suche, Trefferliste, Zeichnungsansicht */

pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

// iPhone/iPad: Web-Apps dürfen dort deutlich weniger Arbeitsspeicher nutzen → kleinere Bilder
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const MAX_BG_PX = IOS ? 2e6 : 3e6;    // Pixelbudget Übersichtsbild (ganze Seite)
const MAX_HI_PX = IOS ? 4e6 : 7e6;    // Pixelbudget scharfer Ausschnitt
const MAX_SCALE = 40;
const LIST_STEP = 60;

const $ = id => document.getElementById(id);
const el = {
  q: $('q'), status: $('status'), sort: $('sort'), list: $('list'),
  viewer: $('viewer'), vTitle: $('vTitle'), scroller: $('scroller'), sheet: $('sheet'),
  bg: $('bg'), hi: $('hi'), hl: $('hl'), rl: $('rl'), vmsg: $('vmsg'),
};

const S = {
  pages: [], numPages: 0, results: [], shown: 0, inc: [],
  pdfP: null, cur: 1, hitPos: -1,
  page: null, base: null, scale: 1, fitScale: 1, fit: true, bgK: 1,
  region: null, rects: [], rectCursor: -1,
};

/* ---------- Normalisierung (Groß/klein, Umlaute, Akzente) ---------- */
const FOLD = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' };
const MARKS = /[̀-ͯ]/g;
function norm(s) {
  return s.toLowerCase().replace(/[äöüß]/g, c => FOLD[c]).normalize('NFD').replace(MARKS, '');
}
function normMap(s) {               // normalisierter Text + Zuordnung zur Originalposition
  let out = ''; const map = [];
  for (let i = 0; i < s.length; i++) {
    const n = norm(s[i]);
    for (let k = 0; k < n.length; k++) { out += n[k]; map.push(i); }
  }
  return { out, map };
}
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- Daten aus dem Gerätespeicher laden ---------- */
async function loadData(bundle) {
  el.status.textContent = 'Lade Suchdaten …';
  const b = bundle || await Store.openBundle();
  const pdfFile = await Store.file(Store.PDF);
  const meta = await Store.readMeta() || {};
  S.bundle = b; S.pdfFile = pdfFile; S.pdfP = null; S.warnHtml = ''; S.pdfPw = meta.pdfPw || '';
  thumbCache.clear();
  const idx = b.head;
  S.numPages = idx.numPages;
  S.pages = idx.pages.map((p, i) => {
    const s = norm(p.t || '').replace(/\s+/g, ' ').trim();
    return {
      n: i + 1, label: p.l || String(i + 1), t: p.t || '', s, c: s.replace(/ /g, ''), ocr: !!p.o,
      nr: p.n || '', bl: p.b || 0, ti: p.ti || '', inh: !!p.h, use: p.u || [], valid: p.g || [], refs: p.r || [],
    };
  });
  // Blattnummer → Seiten; Bauarten und Gültigkeitsvermerke für die Filter
  S.byNr = new Map();
  for (const p of S.pages) if (p.nr) { if (!S.byNr.has(p.nr)) S.byNr.set(p.nr, []); S.byNr.get(p.nr).push(p); }
  S.hg = idx.hg || {};
  S.validLabels = idx.validLabels || {};
  const uc = new Map();
  for (const p of S.pages) for (const u of p.use) uc.set(u, (uc.get(u) || 0) + 1);
  S.useTags = [...uc.entries()].sort((a, b) => (a[0].startsWith('Re ') === b[0].startsWith('Re ') ? 0 : a[0].startsWith('Re ') ? -1 : 1)
    || (parseInt(a[0].slice(3)) || 0) - (parseInt(b[0].slice(3)) || 0) || a[0].localeCompare(b[0]));
  buildFilterUI();
  const noText = S.pages.filter(p => !p.s).length;
  S.statusBase = `${S.numPages} Seiten durchsuchbar` + (noText ? ` · ${noText} ohne Text` : '') + (idx.partial ? ' · TEST-Index (unvollständig)' : '');
  if (idx.fileSize && pdfFile && pdfFile.size !== idx.fileSize && !meta.official) {
    S.warnHtml = ' · <span class="warn">Suchdaten passen nicht zur PDF – bitte Daten neu laden</span>';
  }
  el.status.innerHTML = esc(S.statusBase) + S.warnHtml;
  run();
}

/* ---------- Suche ---------- */
function parse(q) {
  const inc = [], exc = [];
  const re = /"([^"]*)"?|(\S+)/g; let m;
  while ((m = re.exec(q))) {
    if (m[1] !== undefined) {
      const n = norm(m[1]).replace(/\s+/g, ' ').trim();
      if (n) inc.push({ n, c: n.replace(/ /g, ''), phrase: true });
      continue;
    }
    let w = m[2], neg = false;
    if (w.length > 1 && w[0] === '-') { neg = true; w = w.slice(1); }
    if (/^ebs$/i.test(w)) continue;                       // "Ebs" steht auf jedem Blatt
    const num = parseNr(w);
    const n = norm(w);
    if (!n) continue;
    (neg ? exc : inc).push(num ? { n: num, c: num, num, phrase: false } : { n, c: n, phrase: false });
  }
  return { inc, exc };
}
/* Ebs-Nummer oder Anfang davon: "05.71.32", "057132", "ebs05.71", "05.71." → "05.71.32" / "05.71" */
function parseNr(w) {
  const ebs = /^ebs/i.test(w);
  w = w.replace(/^ebs/i, '');
  const six = /^(\d{2})(\d{2})(\d{2})$/.exec(w);
  if (six) return `${six[1]}.${six[2]}.${six[3]}`;
  const m = /^(\d{2})(?:[.,](\d{1,2}))?(?:[.,](\d{1,2}))?([.,]?)$/.exec(w);
  if (!m) return null;
  if (!m[2] && !m[4] && !ebs) return null;     // "05" allein ist eine Zahl – nur "05." oder "ebs05" gilt als Nummer
  return [m[1], m[2], m[3]].filter(Boolean).join('.');
}
const fmtNr = p => p.nr ? `Ebs ${p.nr}${p.bl ? ' Bl.' + p.bl : ''}` : '';
/* Unscharfe Suche (Myers-Algorithmus): findet Stellen mit höchstens k Fehlern */
const fuzzyOn = () => $('fuzzy').checked;
function errLimit(len) { return len >= 9 ? 2 : len >= 5 ? 1 : 0; }
function makePeq(p) {
  const peq = new Map();
  for (let i = 0; i < p.length; i++) { const c = p.charCodeAt(i); peq.set(c, (peq.get(c) || 0) | (1 << i)); }
  return peq;
}
function myers(text, t, onEnd) {           // ruft onEnd(endIndex) für jede Endposition mit ≤ k Fehlern
  const m = t.f.length, k = t.k, peq = t.peq, last = 1 << (m - 1);
  let pv = -1, mv = 0, score = m;
  for (let j = 0; j < text.length; j++) {
    const eq = peq.get(text.charCodeAt(j)) || 0;
    const xv = eq | mv;
    const xh = ((((eq & pv) + pv) | 0) ^ pv) | eq;
    let ph = mv | ~(xh | pv);
    let mh = pv & xh;
    if (ph & last) score++; else if (mh & last) score--;
    ph <<= 1; mh <<= 1;
    pv = mh | ~(xv | ph);
    mv = ph & xv;
    if (score <= k && onEnd(j) === false) return;
  }
}
function fuzzyHas(text, t) { let found = false; myers(text, t, () => { found = true; return false; }); return found; }
function fuzzyRanges(text, t, max = 30) {  // [start, end) – Start näherungsweise
  const out = [];
  myers(text, t, j => {
    const s = Math.max(0, j - t.f.length + 1);
    const l = out[out.length - 1];
    if (l && s <= l[1]) l[1] = j + 1; else out.push([s, j + 1]);
    return out.length < max;
  });
  return out;
}
function prepFuzzy(t) {
  if (t.phrase || t.num || !fuzzyOn()) return;
  const f = t.c.slice(0, 31), k = errLimit(f.length);
  if (k > 0) { t.f = f; t.k = k; t.peq = makePeq(f); }
}

function countOcc(h, n) {
  let c = 0, i = h.indexOf(n);
  while (i >= 0 && c < 50) { c++; i = h.indexOf(n, i + n.length); }
  return c;
}
function search(q) {
  const { inc, exc } = parse(q);
  inc.forEach(prepFuzzy);
  S.inc = inc;
  if (!inc.length) return null;
  const out = [];
  S.hidden = 0;
  outer: for (const p of S.pages) {
    let score = 0;
    for (const t of inc) {
      if (t.num) {                                         // Ebs-Nummer: eigenes Blatt zuerst, sonst Verweis im Text
        if (p.nr && p.nr.startsWith(t.num)) { score += p.inh ? 25 : 30; continue; }
        if (p.c.includes(t.c)) { score += 2; continue; }
        continue outer;
      }
      const exact = t.phrase ? p.s.includes(t.n) : p.c.includes(t.c);
      if (exact) score += 4 + Math.min(countOcc(p.s, t.n), 10) + ((' ' + p.s).includes(' ' + t.n) ? 3 : 0);
      else if (t.peq && fuzzyHas(p.c, t)) score += 1;
      else continue outer;
    }
    for (const t of exc) if (p.c.includes(t.c) || (t.num && p.nr.startsWith(t.num))) continue outer;
    if (!passesFilter(p)) { S.hidden++; continue; }
    out.push({ p, score });
  }
  if (el.sort.value === 'rel') out.sort((a, b) => b.score - a.score || a.p.n - b.p.n);
  return out;
}

/* ---------- Trefferliste ---------- */
function run() {
  const q = el.q.value;
  try { localStorage.setItem('ebs.q', q); } catch {}
  const r = search(q);
  el.list.textContent = ''; S.shown = 0;
  tq.length = 0;
  if (r === null) { S.results = []; el.status.innerHTML = esc(S.statusBase || '') + (S.warnHtml || ''); el.list.append(helpEl()); return; }
  S.results = r;
  const hid = S.hidden ? ` · ${S.hidden} durch Filter ausgeblendet` : '';
  el.status.textContent = (r.length ? `${r.length} ${r.length === 1 ? 'Seite' : 'Seiten'} gefunden` : 'Keine Treffer') + hid;
  if (!r.length) {
    const d = document.createElement('div'); d.className = 'empty';
    d.textContent = S.hidden ? 'Alle Treffer sind durch die Filter ausgeblendet – Filter prüfen.'
      : 'Keine Seite enthält alle Begriffe. Weniger oder kürzere Begriffe probieren.';
    el.list.append(d); return;
  }
  showMore();
}
function showMore() {
  el.list.querySelector('.more')?.remove();
  const end = Math.min(S.results.length, S.shown + LIST_STEP);
  const frag = document.createDocumentFragment();
  for (let i = S.shown; i < end; i++) frag.append(resultEl(S.results[i], i));
  S.shown = end;
  if (S.shown < S.results.length) {
    const b = document.createElement('button'); b.className = 'more';
    b.textContent = `Weitere ${Math.min(LIST_STEP, S.results.length - S.shown)} anzeigen (${S.results.length - S.shown} übrig)`;
    b.onclick = showMore; frag.append(b);
  }
  el.list.append(frag);
}
function resultEl(r, i) {
  const b = document.createElement('button'); b.className = 'hit'; b.type = 'button';
  b.onclick = () => openViewer(i);
  const c = document.createElement('img'); c.className = 'thumb'; c.dataset.page = r.p.n;
  c.alt = ''; c.decoding = 'async';
  thumbIO.observe(c);
  const info = document.createElement('div'); info.className = 'info';
  info.innerHTML = `<div class="ptitle">${pageHead(r.p)}</div>${r.p.ti ? `<div class="ptname">${esc(r.p.ti)}</div>` : ''}`
    + `${badges(r.p)}<div class="snip">${snippet(r.p.t, S.inc.filter(t => !t.num))}</div>`;
  b.append(c, info);
  return b;
}
function pageHead(p) {
  const nr = p.nr ? `<span class="nr">${esc(fmtNr(p))}</span>` : '';
  return `${nr}<small>${nr ? ' · ' : ''}Seite ${p.n}${p.inh ? ' (Folgeseite)' : ''}</small>`;
}
function badges(p) {
  const v = p.valid.map(k => `<span class="badge warnb">${esc(S.validLabels[k] || k)}</span>`).join('');
  const u = p.use.map(k => `<span class="badge">${esc(k)}</span>`).join('');
  return v || u ? `<div class="badges">${v}${u}</div>` : '';
}

/* ---------- Filter: Hauptgruppe, Bauarten ("Verwendbar für"), Gültigkeitsvermerke ---------- */
const F = { hg: '', ng: '', offUse: new Set(), offValid: new Set(), noUse: true };
try {
  const f = JSON.parse(localStorage.getItem('ebs.filter') || '{}');
  F.hg = f.hg || ''; F.ng = f.ng || ''; F.offUse = new Set(f.offUse || []); F.offValid = new Set(f.offValid || []); F.noUse = f.noUse !== false;
} catch {}
function saveFilter() {
  try { localStorage.setItem('ebs.filter', JSON.stringify({ hg: F.hg, ng: F.ng, offUse: [...F.offUse], offValid: [...F.offValid], noUse: F.noUse })); } catch {}
}
function passesFilter(p) {
  if (F.hg && !p.nr.startsWith(F.hg + '.')) return false;
  if (F.ng && !p.nr.startsWith(F.ng + '.')) return false;
  if (p.valid.some(k => F.offValid.has(k))) return false;
  if (p.use.length) { if (p.use.every(u => F.offUse.has(u))) return false; }
  else if (!F.noUse) return false;
  return true;
}
function activeFilters() {
  return (F.hg ? 1 : 0) + (F.ng ? 1 : 0) + F.offUse.size + F.offValid.size + (F.noUse ? 0 : 1);
}
function buildFilterUI() {
  const sel = $('fHg');
  sel.innerHTML = '<option value="">Alle Hauptgruppen</option>' + Object.keys(S.hg).sort()
    .map(k => `<option value="${k}">${k} – ${esc(S.hg[k])}</option>`).join('');
  sel.value = F.hg;
  fillNg();
  const chip = (label, count, off, onToggle) => {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'chip' + (off ? ' off' : '');
    b.innerHTML = `${esc(label)} <small>${count}</small>`;
    b.setAttribute('aria-pressed', String(!off));
    b.onclick = () => { onToggle(); b.classList.toggle('off'); b.setAttribute('aria-pressed', String(!b.classList.contains('off'))); filterChanged(); };
    return b;
  };
  const fu = $('fUse'); fu.textContent = '';
  for (const [u, c] of S.useTags) fu.append(chip(u, c, F.offUse.has(u), () => F.offUse.has(u) ? F.offUse.delete(u) : F.offUse.add(u)));
  fu.append(chip('ohne Angabe', S.pages.filter(p => !p.use.length).length, !F.noUse, () => { F.noUse = !F.noUse; }));
  const fv = $('fValid'); fv.textContent = '';
  const vc = new Map();
  for (const p of S.pages) for (const k of p.valid) vc.set(k, (vc.get(k) || 0) + 1);
  for (const k of Object.keys(S.validLabels)) {
    if (!vc.get(k)) continue;
    fv.append(chip(S.validLabels[k], vc.get(k), F.offValid.has(k), () => F.offValid.has(k) ? F.offValid.delete(k) : F.offValid.add(k)));
  }
  updateFilterCount();
}
function updateFilterCount() {
  const n = activeFilters();
  $('filterSum').textContent = n ? `Filter (${n} aktiv)` : 'Filter';
  $('filterSum').classList.toggle('active', !!n);
}
function filterChanged() { saveFilter(); updateFilterCount(); run(); }
$('fHg').onchange = e => { F.hg = e.target.value; F.ng = ''; fillNg(); filterChanged(); };
$('fNg').onchange = e => { F.ng = e.target.value; filterChanged(); };
function fillNg() {                       // Nebengruppen (xx.yy) der gewählten Hauptgruppe, mit Titel des ersten Blatts
  const sel = $('fNg');
  if (!F.hg) { sel.innerHTML = '<option value="">– erst Hauptgruppe wählen –</option>'; sel.disabled = true; return; }
  const groups = new Map();
  for (const s of sheets()) if (s.nr.startsWith(F.hg + '.')) {
    const k = s.nr.slice(0, 5);
    if (!groups.has(k)) groups.set(k, s.p.ti || '');
  }
  sel.disabled = false;
  sel.innerHTML = '<option value="">Alle Nebengruppen</option>' + [...groups.entries()]
    .map(([k, t]) => `<option value="${k}">${k}${t ? ' – ' + esc(t.slice(0, 50)) : ''}</option>`).join('');
  if (F.ng && !groups.has(F.ng)) F.ng = '';
  sel.value = F.ng;
}
$('fReset').onclick = () => { F.hg = ''; F.ng = ''; F.offUse.clear(); F.offValid.clear(); F.noUse = true; saveFilter(); buildFilterUI(); run(); };
function snippet(t, terms) {
  const { out, map } = normMap(t);
  const ranges = [], firsts = [];
  for (const term of terms) {
    let i = out.indexOf(term.n), k = 0;
    while (i >= 0 && k < 30) {
      const r = [map[i], map[i + term.n.length - 1] + 1];
      if (k === 0) firsts.push(r);
      ranges.push(r); k++;
      i = out.indexOf(term.n, i + term.n.length);
    }
    if (!k && term.peq) {
      const fr = fuzzyRanges(out, term);
      fr.forEach((r, idx) => {
        const o = [map[r[0]], map[r[1] - 1] + 1];
        if (idx === 0) firsts.push(o);
        ranges.push(o);
      });
    }
  }
  if (!firsts.length) return esc(t.slice(0, 180)) + (t.length > 180 ? ' …' : '');
  firsts.sort((a, b) => a[0] - b[0]);
  const wins = [];
  for (const [s, e] of firsts) {
    const w = [Math.max(0, s - 45), Math.min(t.length, e + 45)];
    const last = wins[wins.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]); else wins.push(w);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const l = merged[merged.length - 1];
    if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else merged.push([...r]);
  }
  return wins.map(([ws, we]) => {
    let html = ws > 0 ? '… ' : '', pos = ws;
    for (const [rs, re] of merged) {
      if (re <= ws || rs >= we) continue;
      const a = Math.max(rs, ws), z = Math.min(re, we);
      html += esc(t.slice(pos, a)) + '<mark>' + esc(t.slice(a, z)) + '</mark>';
      pos = z;
    }
    return html + esc(t.slice(pos, we)) + (we < t.length ? ' …' : '');
  }).join(' ');
}
function helpEl() {
  const d = document.createElement('div'); d.className = 'help';
  d.innerHTML = `<h2>So funktioniert die Suche</h2><ul>
    <li>Mehrere Begriffe eingeben, z. B. <code>trafo 110kv feld</code>: gefunden werden Seiten, auf denen <b>alle</b> Begriffe vorkommen, egal wo und in welcher Reihenfolge.</li>
    <li>Wortteile genügen: <code>schalt</code> findet Schalter, Schaltanlage, Ausschaltung …</li>
    <li>Groß/klein und Umlaute sind egal: <code>pruefung</code> = <code>Prüfung</code>.</li>
    <li><code>-wort</code> schließt Seiten mit diesem Begriff aus.</li>
    <li><code>"genaue folge"</code> sucht eine feste Wortfolge.</li>
    <li><b>Unscharf</b> (Standard): findet auch Wörter mit Lesefehlern aus der Texterkennung, z. B. „nnchgespannt“ bei <code>nachgespannt</code>. Exakte Treffer stehen oben.</li>
    <li><b>Ebs-Nummer</b> eingeben, z. B. <code>05.71.32</code> oder nur den Anfang <code>52.1</code>: das Blatt selbst steht oben, darunter Blätter, die darauf verweisen. Kombinierbar: <code>05.71 bogen</code>.</li>
    <li><b>Inhalt</b>: Blätter nach Hauptgruppe → Gruppe → Blatt durchblättern.</li>
    <li><b>Filter</b>: Bauarten („Verwendbar für“, z. B. Re 200, S-Bahn) und Gültigkeitsvermerke („Für Neubau ungültig“ …) ein- oder ausblenden.</li>
    <li>In der Zeichnung: <b>Fundstelle</b> zoomt nacheinander auf jede Markierung. <b>Ebs-Nr.</b> öffnet ein verschiebbares Fenster mit Ziffernblock: Nummer eintippen (Punkte kommen automatisch), das Blatt öffnet sich (immer Blatt 1), „← zurück zu …“ führt zurück. Zoomen mit Mausrad, Doppelklick oder zwei Fingern.</li>
  </ul>`;
  return d;
}

/* ---------- PDF ---------- */
/* pdf.js liest nur die benötigten Teile der lokal gespeicherten PDF */
class BlobRangeTransport extends pdfjsLib.PDFDataRangeTransport {
  constructor(blob) { super(blob.size, null); this.blob = blob; }
  requestDataRange(begin, end) {
    this.blob.slice(begin, end).arrayBuffer().then(buf => this.onDataRange(begin, new Uint8Array(buf)));
  }
}
function getPdf() {
  if (!S.pdfP) {
    if (!S.pdfFile) return Promise.reject(new Error('Keine PDF auf diesem Gerät'));
    S.pdfP = pdfjsLib.getDocument({
      range: new BlobRangeTransport(S.pdfFile), password: S.pdfPw || undefined, disableAutoFetch: true, disableStream: true, rangeChunkSize: 1 << 19,
    }).promise;
    S.pdfP.catch(() => { S.pdfP = null; });
  }
  return S.pdfP;
}

/* ---------- Vorschaubilder ---------- */
// Fertige kleine JPGs aus dem Datenpaket – die PDF wird für die Liste nicht angefasst
// (ganze Scan-Seiten zu rendern hat auf dem iPhone den Arbeitsspeicher gesprengt).
const thumbCache = new Map();
const tq = [];
const thumbIO = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) { thumbIO.unobserve(e.target); showThumb(e.target); }
}, { rootMargin: '400px' });
function pumpThumbs() {}
function showThumb(img) {
  const blob = S.bundle && S.bundle.thumb(+img.dataset.page);
  if (!blob) { img.classList.add('fail'); return; }
  const url = URL.createObjectURL(blob);
  img.onload = img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

/* ---------- Zeichnungsansicht ---------- */
let pageSeq = 0, bgTask = null, hiTask = null, hiTimer = 0;

function openViewer(i) { S.hitPos = i; S.nav = []; showPage(S.results[i].p.n); }

/* ---------- Verweise: Ebs-Nummer eingeben, Blatt öffnen, mit Zurück ---------- */
S.nav = [];
function findSheet(nr) {                 // bei mehreren Blättern immer Blatt 1 (sonst das erste Blatt in der PDF)
  const pages = S.byNr.get(nr);
  if (!pages) return null;
  const direct = pages.filter(p => !p.inh);
  const bl1 = direct.find(p => p.bl === 1);
  if (bl1) return bl1;
  // Blatt 1 nicht erkannt: Anfang der längsten zusammenhängenden Seitenfolge dieser Nummer
  // (einzelne Seiten mit falsch gelesener Nummer liegen meist allein)
  let best = null, cur = null;
  for (const p of pages) {
    if (cur && p.n === cur.last + 1) { cur.last = p.n; cur.len++; } else { cur = { first: p, last: p.n, len: 1 }; }
    if (!best || cur.len > best.len) best = cur;
  }
  return best ? best.first : (direct[0] || pages[0]);
}
function followRef(nr) {
  const t = findSheet(nr);
  if (!t) return false;
  if (t.n !== S.cur) {
    S.nav.push({ page: S.cur, hitPos: S.hitPos });
    S.hitPos = -1;
    showPage(t.n);
  }
  return true;
}

/* Fenster „Gehe zu Ebs-Nr.“: verschiebbar, eigener Ziffernblock, Punkte nach je 2 Ziffern */
const G = { digits: '' };
const touchDevice = matchMedia('(pointer: coarse)').matches;
function gotoFmt(d) {
  return d.replace(/^(\d{2})(\d{0,2})(\d{0,2}).*$/, (m, a, b, c) => a + '.' + (b ? b + (b.length === 2 ? '.' + c : '') : ''))
    .replace(/^(\d)$/, '$1');
}
function openGoto() {
  if (!S.pages.length) return;
  G.digits = '';
  const w = $('gotoWin');
  w.hidden = false;
  try {
    const pos = JSON.parse(localStorage.getItem('ebs.gotoPos') || 'null');
    if (pos) { w.style.left = pos.x + 'px'; w.style.top = pos.y + 'px'; w.style.right = 'auto'; w.style.bottom = 'auto'; }
  } catch {}
  keepInView(w);
  gotoRender();
  if (!touchDevice) $('gotoInput').focus();
}
function closeGoto() { $('gotoWin').hidden = true; }
function gotoRender() {
  const d = G.digits;
  $('gotoInput').value = d ? gotoFmt(d) : '';
  const box = $('gotoHits'); box.textContent = ''; $('gotoMsg').textContent = '';
  if (d.length < 2) { $('gotoMsg').textContent = 'Ziffern eingeben – die Punkte kommen automatisch.'; keepInView($('gotoWin')); return; }
  const prefix = gotoFmt(d).replace(/\.$/, '');
  const hits = sheets().filter(s => s.nr.startsWith(prefix));
  if (!hits.length) { $('gotoMsg').textContent = `Keine Ebs ${prefix}… in dieser PDF.`; return; }
  for (const s of hits.slice(0, 6)) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'gotohit';
    b.innerHTML = `<b>Ebs ${s.nr}</b> <span>${esc(s.p.ti || '')}</span>`;
    b.onclick = () => gotoOpen(s.nr);
    box.append(b);
  }
  if (hits.length > 6) $('gotoMsg').textContent = `… und ${hits.length - 6} weitere – weitere Ziffern eingeben.`;
  keepInView($('gotoWin'));
}
function gotoOpen(nr) {
  if (!followRef(nr)) { $('gotoMsg').textContent = `Ebs ${nr} ist in dieser PDF nicht enthalten.`; return; }
  closeGoto();
}
function gotoKey(k) {
  if (/^\d$/.test(k)) { if (G.digits.length < 6) G.digits += k; }
  else if (k === 'back') G.digits = G.digits.slice(0, -1);
  else if (k === 'clear') G.digits = '';
  else if (k === 'ok') {
    if (G.digits.length === 6) return gotoOpen(gotoFmt(G.digits));
    const first = $('gotoHits').querySelector('.gotohit');
    if (first && $('gotoHits').children.length === 1) return first.click();
    $('gotoMsg').textContent = 'Bitte alle 6 Ziffern eingeben oder ein Blatt antippen.';
    return;
  }
  gotoRender();
  if (G.digits.length === 6 && S.byNr.has(gotoFmt(G.digits))) gotoOpen(gotoFmt(G.digits));
}
function keepInView(w) {
  const r = w.getBoundingClientRect(), m = 6;
  const x = Math.min(Math.max(m, r.left), innerWidth - r.width - m);
  const y = Math.min(Math.max(m, r.top), innerHeight - r.height - m);
  w.style.left = x + 'px'; w.style.top = y + 'px'; w.style.right = 'auto'; w.style.bottom = 'auto';
}
(() => {
  const w = $('gotoWin'), h = $('gotoHead');
  let d = null;
  h.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r = w.getBoundingClientRect();
    d = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    h.setPointerCapture(e.pointerId); e.preventDefault();
  });
  h.addEventListener('pointermove', e => {
    if (!d) return;
    w.style.left = e.clientX - d.dx + 'px'; w.style.top = e.clientY - d.dy + 'px';
    w.style.right = 'auto'; w.style.bottom = 'auto';
  });
  const end = () => {
    if (!d) return; d = null; keepInView(w);
    try { localStorage.setItem('ebs.gotoPos', JSON.stringify({ x: parseInt(w.style.left), y: parseInt(w.style.top) })); } catch {}
  };
  h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
  w.querySelectorAll('[data-k]').forEach(b => b.addEventListener('click', () => gotoKey(b.dataset.k)));
  $('gotoClose').onclick = closeGoto;
  const inp = $('gotoInput');
  if (touchDevice) { inp.readOnly = true; inp.inputMode = 'none'; }
  inp.addEventListener('keydown', e => {
    e.stopPropagation();
    if (/^\d$/.test(e.key)) gotoKey(e.key);
    else if (e.key === 'Backspace') gotoKey('back');
    else if (e.key === 'Delete') gotoKey('clear');
    else if (e.key === 'Enter') gotoKey('ok');
    else if (e.key === 'Escape') closeGoto();
    else if (e.key === 'Tab') return;
    e.preventDefault();
  });
  inp.addEventListener('paste', e => {      // eingefügte Nummer übernehmen, z. B. "05.71.32"
    e.preventDefault();
    G.digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    gotoRender();
  });
  addEventListener('resize', () => { if (!w.hidden) keepInView(w); });
})();
function navBack() {
  const s = S.nav.pop();
  if (!s) return false;
  S.hitPos = s.hitPos;
  showPage(s.page);
  return true;
}
function drawRefs() { el.rl.textContent = ''; }   // antippbare Rahmen abgeschaltet (OCR-Positionen zu ungenau)
let flashT = 0;
function flash(text) { msg(text); clearTimeout(flashT); flashT = setTimeout(() => msg(''), 2500); }

function showPage(n) {
  if (el.viewer.hidden) {
    el.viewer.hidden = false; document.body.classList.add('viewing');
    history.pushState({ viewer: true }, '');
  }
  S.cur = n;
  const pos = S.results.findIndex(r => r.p.n === n);
  if (S.hitPos < 0 || S.results[S.hitPos]?.p.n !== n) S.hitPos = pos;
  updateTitle();
  loadPage();
}
function closeViewer() {
  pageSeq++;
  bgTask?.cancel(); hiTask?.cancel();
  el.viewer.hidden = true; document.body.classList.remove('viewing');
  S.nav = []; closeGoto();
  if (S.fromToc) { S.fromToc = false; run(); $('toc').hidden = false; document.body.classList.add('viewing'); }
}
function updateTitle() {
  const p = S.pages[S.cur - 1];
  const lbl = p && p.nr ? `${fmtNr(p)} · ` : '';
  let t = `${lbl}Seite ${S.cur}/${S.numPages}`;
  const back = S.nav[S.nav.length - 1];
  $('vBack').hidden = !back;
  if (back) {
    const bp = S.pages[back.page - 1];
    $('vBack').textContent = `← zurück zu ${bp && bp.nr ? fmtNr(bp) : 'Seite ' + back.page}`;
  }
  if (S.hitPos >= 0) t += ` · Treffer ${S.hitPos + 1}/${S.results.length}`;
  if (S.rects.length) t += ` · ${S.rects.length} Markierung${S.rects.length === 1 ? '' : 'en'}`;
  el.vTitle.textContent = t;
  $('vPrevHit').disabled = !(S.hitPos > 0);
  $('vNextHit').disabled = !(S.hitPos >= 0 && S.hitPos < S.results.length - 1);
  $('vPrevPage').disabled = S.cur <= 1;
  $('vNextPage').disabled = S.cur >= S.numPages;
  $('vSpot').disabled = !S.rects.length;
}
function msg(text) { el.vmsg.textContent = text; el.vmsg.classList.toggle('show', !!text); }

function freeCanvas(c) { c.width = 0; c.height = 0; }

async function loadPage() {
  const seq = ++pageSeq;
  bgTask?.cancel(); hiTask?.cancel(); clearTimeout(hiTimer);
  S.region = null; S.rects = []; S.rectCursor = -1;
  el.hi.style.display = 'none'; el.bg.style.visibility = 'hidden'; el.hl.textContent = '';
  el.viewer.classList.add('loading'); msg('Lade Zeichnung …');
  updateTitle();
  let page;
  try {
    const pdf = await getPdf();
    page = await pdf.getPage(S.cur);
  } catch (e) {
    if (seq === pageSeq) { el.viewer.classList.remove('loading'); msg('Zeichnung konnte nicht geladen werden: ' + (e?.message || e)); }
    return;
  }
  if (seq !== pageSeq) return;
  S.page?.cleanup?.();
  S.page = page; S.base = page.getViewport({ scale: 1 });
  computeFit(); S.fit = true; S.scale = S.fitScale;
  drawRefs();
  layout(); el.scroller.scrollTo(0, 0);

  const pinfo = S.pages[S.cur - 1];
  const rectsP = pinfo?.ocr
    ? S.bundle.words(S.cur).then(w => ocrRects(w, S.inc))
    : page.getTextContent().then(tc => hitRects(tc.items, S.inc, S.base));
  rectsP.then(rects => {
    if (seq !== pageSeq) return;
    S.rects = rects;
    drawHl(); updateTitle();
  }).catch(() => {});

  const area = S.base.width * S.base.height;
  S.bgK = Math.min(Math.sqrt(MAX_BG_PX / area), 6);
  const vp = page.getViewport({ scale: S.bgK });
  const cv = document.createElement('canvas');
  cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
  const task = bgTask = page.render({ canvasContext: cv.getContext('2d'), viewport: vp });
  try { await task.promise; } catch { freeCanvas(cv); return; }
  if (seq !== pageSeq) { freeCanvas(cv); return; }
  cv.id = 'bg'; cv.className = 'bg';
  freeCanvas(el.bg); el.bg.replaceWith(cv); el.bg = cv;
  el.viewer.classList.remove('loading'); msg('');
  scheduleHi(0);
}

function computeFit() {
  const W = Math.max(50, el.scroller.clientWidth - 16), H = Math.max(50, el.scroller.clientHeight - 16);
  S.fitScale = Math.min(W / S.base.width, H / S.base.height);
}
function layout() {
  if (!S.base) return;
  const sc = S.scale;
  el.sheet.style.width = S.base.width * sc + 'px';
  el.sheet.style.height = S.base.height * sc + 'px';
  const R = S.region;
  if (R) Object.assign(el.hi.style, { left: R.x * sc + 'px', top: R.y * sc + 'px', width: R.w * sc + 'px', height: R.h * sc + 'px' });
  const kids = el.hl.children;
  for (let i = 0; i < kids.length; i++) {
    const r = S.rects[i], d = kids[i];
    d.style.left = r.x * sc - 2 + 'px'; d.style.top = r.y * sc - 2 + 'px';
    d.style.width = r.w * sc + 4 + 'px'; d.style.height = r.h * sc + 4 + 'px';
    d.style.transform = r.a ? `rotate(${r.a}rad)` : '';
  }
  const refs = (S.pages[S.cur - 1] || {}).refs || [], rk = el.rl.children;
  for (let i = 0; i < rk.length && i < refs.length; i++) {
    const r = refs[i], d = rk[i];
    d.style.left = r[2] * sc - 2 + 'px'; d.style.top = r[3] * sc - 2 + 'px';
    d.style.width = r[4] * sc + 4 + 'px'; d.style.height = r[5] * sc + 4 + 'px';
  }
}

function scheduleHi(delay = 160) { clearTimeout(hiTimer); hiTimer = setTimeout(renderHi, delay); }
async function renderHi() {
  const page = S.page; if (!page || el.viewer.hidden) return;
  const seq = pageSeq, sc = S.scale, dpr = window.devicePixelRatio || 1;
  if (sc * dpr <= S.bgK * 1.05) { el.hi.style.display = 'none'; S.region = null; return; }
  const bw = S.base.width, bh = S.base.height, sx = el.scroller;
  const vx = Math.max(0, (sx.scrollLeft - el.sheet.offsetLeft) / sc);
  const vy = Math.max(0, (sx.scrollTop - el.sheet.offsetTop) / sc);
  const vw = Math.min(bw - vx, sx.clientWidth / sc), vh = Math.min(bh - vy, sx.clientHeight / sc);
  const R = S.region;
  if (R && R.scale === sc && vx >= R.x - .5 && vy >= R.y - .5 && vx + vw <= R.x + R.w + .5 && vy + vh <= R.y + R.h + .5) return;
  const x = Math.max(0, vx - vw * .25), y = Math.max(0, vy - vh * .25);
  const w = Math.min(bw - x, vw * 1.5), h = Math.min(bh - y, vh * 1.5);
  let k = dpr;
  if (w * sc * h * sc * k * k > MAX_HI_PX) k = Math.sqrt(MAX_HI_PX / (w * sc * h * sc));
  const vp = page.getViewport({ scale: sc });
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.ceil(w * sc * k)); cv.height = Math.max(1, Math.ceil(h * sc * k));
  hiTask?.cancel();
  const task = hiTask = page.render({
    canvasContext: cv.getContext('2d'), viewport: vp, transform: [k, 0, 0, k, -x * sc * k, -y * sc * k],
  });
  try { await task.promise; } catch { freeCanvas(cv); return; }
  if (seq !== pageSeq || sc !== S.scale) { freeCanvas(cv); return; }
  cv.id = 'hi'; cv.className = 'hi';
  freeCanvas(el.hi); el.hi.replaceWith(cv); el.hi = cv;
  S.region = { x, y, w, h, scale: sc };
  layout();
}

function setScaleAnchored(ns, px, py, cx, cy) {
  if (!S.base) return;
  ns = Math.min(MAX_SCALE, Math.max(S.fitScale * 0.5, ns));
  S.scale = ns; S.fit = false;
  layout();
  el.scroller.scrollLeft = px * ns + el.sheet.offsetLeft - cx;
  el.scroller.scrollTop = py * ns + el.sheet.offsetTop - cy;
  scheduleHi();
}
function zoomAt(ns, cx, cy) {
  if (!S.base) return;
  if (cx == null) { cx = el.scroller.clientWidth / 2; cy = el.scroller.clientHeight / 2; }
  const px = (el.scroller.scrollLeft + cx - el.sheet.offsetLeft) / S.scale;
  const py = (el.scroller.scrollTop + cy - el.sheet.offsetTop) / S.scale;
  setScaleAnchored(ns, px, py, cx, cy);
}
function fitPage() {
  if (!S.base) return;
  computeFit(); S.fit = true; S.scale = S.fitScale; layout(); el.scroller.scrollTo(0, 0); scheduleHi(0);
}

/* Markierungen: Text-Elemente der Seite, die einen Suchbegriff enthalten */
function matchIdx(strs, terms) {   // Indizes der Textelemente, die einen Suchbegriff (ggf. über mehrere Elemente) enthalten
  let s = ''; const starts = [], lens = [];
  for (const str of strs) {
    starts.push(s.length);
    const n = norm(str || '').replace(/\s+/g, '');
    lens.push(n.length); s += n;
  }
  const items = strs;
  const hit = new Set();
  const mark = (i, e, k) => {      // Elemente markieren, die genug vom Treffer abdecken
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= i) lo = mid; else hi = mid - 1; }
    for (let j = lo; j < items.length && starts[j] < e; j++) {
      const ov = Math.min(e, starts[j] + lens[j]) - Math.max(i, starts[j]);
      if (!lens[j] || ov < Math.min(lens[j], k + 1)) continue;
      // unscharf: sehr kurze Elemente nur, wenn sie innen liegen (nicht am unsicheren Rand)
      if (k && lens[j] <= k + 1 && (starts[j] < i + k || starts[j] + lens[j] > e - k)) continue;
      hit.add(j);
    }
  };
  for (const t of terms) {
    const nd = t.c; if (!nd) continue;
    if (t.peq) { fuzzyRanges(s, t, 400).forEach(([a, z]) => mark(a, z, t.k)); continue; }
    let i = s.indexOf(nd), guard = 0;
    while (i >= 0 && guard++ < 400) { mark(i, i + nd.length, 0); i = s.indexOf(nd, i + 1); }
  }
  return [...hit].sort((a, b) => a - b).slice(0, 600);
}
function ocrRects(words, terms) {     // OCR-Wörter: [text, x, y, w, h, senkrecht]
  if (!terms.length || !words) return [];
  return matchIdx(words.map(w => w[0]), terms).map(j => {
    const [, x, y, w, h, v] = words[j];
    return { x, y, w, h, a: 0, th: v ? w : h, box: { x, y, w, h } };
  });
}
function hitRects(items, terms, vp) {
  if (!terms.length) return [];
  return matchIdx(items.map(it => it.str), terms).map(j => {
    const it = items[j];
    const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
    const fh = Math.hypot(tx[2], tx[3]) || 1;
    const a = Math.atan2(tx[1], tx[0]);
    const x = tx[4] + fh * Math.sin(a), y = tx[5] - fh * Math.cos(a);
    const w = Math.max(it.width || 0, fh * 0.6);
    const ca = Math.cos(a), sa = Math.sin(a);
    const pts = [[x, y], [x + w * ca, y + w * sa], [x - fh * sa, y + fh * ca], [x + w * ca - fh * sa, y + w * sa + fh * ca]];
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const bx = Math.min(...xs), by = Math.min(...ys);
    return { x, y, w, h: fh * 1.1, a, th: fh, box: { x: bx, y: by, w: Math.max(...xs) - bx, h: Math.max(...ys) - by } };
  });
}
function drawHl() {
  el.hl.textContent = '';
  for (let i = 0; i < S.rects.length; i++) el.hl.append(document.createElement('div'));
  layout();
}
function spot(dir = 1) {
  const n = S.rects.length; if (!n) return;
  S.rectCursor = ((S.rectCursor + dir) % n + n) % n;
  const r = S.rects[S.rectCursor];
  [...el.hl.children].forEach((d, i) => d.classList.toggle('active', i === S.rectCursor));
  const ns = Math.min(MAX_SCALE, Math.max(S.fitScale, 28 / Math.max(r.th || r.h, 0.5)));
  const b = r.box;
  setScaleAnchored(ns, b.x + b.w / 2, b.y + b.h / 2, el.scroller.clientWidth / 2, el.scroller.clientHeight / 2);
  const p = el.hl.children[S.rectCursor];
  if (p) { p.style.animation = 'none'; void p.offsetWidth; p.style.animation = ''; }
}

/* ---------- Bedienung ---------- */
function gotoHit(d) {
  const i = S.hitPos + d;
  if (i < 0 || i >= S.results.length) return;
  S.hitPos = i; showPage(S.results[i].p.n);
}
function gotoPage(d) {
  const n = S.cur + d;
  if (n < 1 || n > S.numPages) return;
  S.hitPos = -1; showPage(n);
}
$('vClose').onclick = () => (history.state?.viewer ? history.back() : closeViewer());
$('vPrevHit').onclick = () => gotoHit(-1);
$('vNextHit').onclick = () => gotoHit(1);
$('vPrevPage').onclick = () => gotoPage(-1);
$('vNextPage').onclick = () => gotoPage(1);
$('vZoomIn').onclick = () => zoomAt(S.scale * 1.5);
$('vZoomOut').onclick = () => zoomAt(S.scale / 1.5);
$('vFit').onclick = fitPage;
$('vSpot').onclick = () => spot(1);
$('vBack').onclick = navBack;
$('vGoto').onclick = () => ($('gotoWin').hidden ? openGoto() : closeGoto());
window.addEventListener('popstate', () => {
  if (!el.viewer.hidden) closeViewer();
  else if (!$('toc').hidden) closeToc();
});

/* ---------- Inhalt: Hauptgruppe → Gruppe (xx.yy) → Blätter ---------- */
const T = { hg: '', grp: '' };
function sheets() {
  if (!S.sheetList || S.sheetList.src !== S.pages) {
    S.sheetList = [...S.byNr.entries()]
      .map(([nr, ps]) => ({ nr, p: ps.find(p => !p.inh) || ps[0], pages: ps.length }))
      .sort((a, b) => a.nr.localeCompare(b.nr));
    S.sheetList.src = S.pages;
  }
  return S.sheetList;
}
function openToc() {
  if (!S.pages.length) return;
  T.hg = ''; T.grp = '';
  $('toc').hidden = false; document.body.classList.add('viewing');
  history.pushState({ toc: true }, '');
  renderToc();
}
function closeToc() { $('toc').hidden = true; document.body.classList.remove('viewing'); }
function tocRow(main, sub, count, onClick, extra = '') {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'tocrow';
  b.innerHTML = `<span class="tmain">${main}</span>${count != null ? `<span class="tcount">${count}</span>` : ''}`
    + (sub ? `<span class="tsub">${sub}</span>` : '') + extra;
  b.onclick = onClick;
  return b;
}
function renderToc() {
  const list = $('tocList'); list.textContent = '';
  const all = sheets().filter(s => passesFilter(s.p));
  const n = activeFilters();
  const note = n ? `<div class="tocnote">${n} Filter aktiv – ausgeblendete Blätter fehlen hier.</div>` : '';
  list.insertAdjacentHTML('beforeend', note);
  if (!T.hg) {
    $('tocPath').textContent = 'Inhalt – Hauptgruppen';
    const groups = new Map();
    for (const s of all) { const k = s.nr.slice(0, 2); groups.set(k, (groups.get(k) || 0) + 1); }
    for (const [k, c] of [...groups.entries()].sort()) {
      list.append(tocRow(`<b>${k}</b> ${esc(S.hg[k] || '')}`, '', c, () => { T.hg = k; renderToc(); list.scrollTop = 0; }));
    }
  } else if (!T.grp) {
    $('tocPath').textContent = `${T.hg} ${S.hg[T.hg] || ''}`;
    const groups = new Map();
    for (const s of all) if (s.nr.startsWith(T.hg + '.')) {
      const k = s.nr.slice(0, 5);
      if (!groups.has(k)) groups.set(k, { c: 0, first: s });
      groups.get(k).c++;
    }
    for (const [k, g] of groups) {
      list.append(tocRow(`<b>${k}</b>`, esc(g.first.p.ti || ''), g.c, () => { T.grp = k; renderToc(); list.scrollTop = 0; }));
    }
  } else {
    $('tocPath').textContent = `${T.grp} · ${S.hg[T.hg] || ''}`;
    const grp = all.filter(s => s.nr.startsWith(T.grp + '.'));
    grp.forEach((s, i) => {
      list.append(tocRow(`<b>Ebs ${s.nr}</b>`, esc(s.p.ti || ''), s.pages > 1 ? `${s.pages} S.` : null, () => {
        S.results = grp.map(x => ({ p: x.p, score: 0 })); S.inc = []; S.fromToc = true;
        $('toc').hidden = true;
        openViewer(i);
      }, badges(s.p)));
    });
  }
  if (!list.querySelector('.tocrow')) list.insertAdjacentHTML('beforeend', '<div class="empty">Keine Blätter (Filter prüfen).</div>');
}
$('tocBtn').onclick = openToc;
$('tocClose').onclick = () => {
  if (T.grp) { T.grp = ''; renderToc(); }
  else if (T.hg) { T.hg = ''; renderToc(); }
  else if (history.state?.toc) history.back(); else closeToc();
};

document.addEventListener('keydown', e => {
  if (!$('gotoWin').hidden) {                       // Nummernfenster offen: Tasten gehen dorthin
    const map = { Backspace: 'back', Delete: 'clear', Enter: 'ok' };
    if (/^\d$/.test(e.key) || map[e.key]) { e.preventDefault(); gotoKey(map[e.key] || e.key); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeGoto(); return; }
  }
  if (el.viewer.hidden) {
    if (e.key === 'Escape' && !$('toc').hidden) $('tocClose').click();
    else if (e.key === '/' && document.activeElement !== el.q) { e.preventDefault(); el.q.focus(); }
    return;
  }
  const k = e.key;
  if (k === 'Escape') { if (!navBack()) $('vClose').click(); }
  else if (k === 'Backspace') { e.preventDefault(); navBack(); }
  else if (k === '#' || k === 'g') { e.preventDefault(); openGoto(); }
  else if (k === 'ArrowLeft' && !e.altKey) gotoPage(-1);
  else if (k === 'ArrowRight' && !e.altKey) gotoPage(1);
  else if (k === 'PageUp') { e.preventDefault(); gotoHit(-1); }
  else if (k === 'PageDown') { e.preventDefault(); gotoHit(1); }
  else if (k === '+' || k === '=') zoomAt(S.scale * 1.5);
  else if (k === '-') zoomAt(S.scale / 1.5);
  else if (k === '0') fitPage();
  else if (k === 'Enter' || k === 'f') spot(e.shiftKey ? -1 : 1);
});

const sx = el.scroller;
sx.addEventListener('scroll', () => scheduleHi(), { passive: true });
sx.addEventListener('wheel', e => {
  e.preventDefault();
  const d = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
  const r = sx.getBoundingClientRect();
  zoomAt(S.scale * Math.exp(-d * 0.0018), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
sx.addEventListener('dblclick', e => {
  const r = sx.getBoundingClientRect();
  zoomAt(S.scale * 2.5, e.clientX - r.left, e.clientY - r.top);
});
let drag = null;
sx.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'mouse' || e.button !== 0 || e.target.closest('.ref')) return;
  drag ={ x: e.clientX, y: e.clientY, sl: sx.scrollLeft, st: sx.scrollTop };
  sx.setPointerCapture(e.pointerId); sx.classList.add('dragging');
});
sx.addEventListener('pointermove', e => {
  if (!drag) return;
  sx.scrollLeft = drag.sl - (e.clientX - drag.x); sx.scrollTop = drag.st - (e.clientY - drag.y);
});
const endDrag = () => { drag = null; sx.classList.remove('dragging'); };
sx.addEventListener('pointerup', endDrag); sx.addEventListener('pointercancel', endDrag);

let pinch = null;
function touchMid(e) {
  const [a, b] = e.touches, r = sx.getBoundingClientRect();
  return { x: (a.clientX + b.clientX) / 2 - r.left, y: (a.clientY + b.clientY) / 2 - r.top, d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1 };
}
sx.addEventListener('touchstart', e => {
  if (e.touches.length !== 2 || !S.base) return;
  e.preventDefault();
  const m = touchMid(e);
  pinch = { d0: m.d, s0: S.scale, px: (sx.scrollLeft + m.x - el.sheet.offsetLeft) / S.scale, py: (sx.scrollTop + m.y - el.sheet.offsetTop) / S.scale };
}, { passive: false });
sx.addEventListener('touchmove', e => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  const m = touchMid(e);
  setScaleAnchored(pinch.s0 * m.d / pinch.d0, pinch.px, pinch.py, m.x, m.y);
}, { passive: false });
sx.addEventListener('touchend', e => { if (e.touches.length < 2) pinch = null; });
document.addEventListener('gesturestart', e => e.preventDefault());

let rsT = 0;
window.addEventListener('resize', () => {
  clearTimeout(rsT);
  rsT = setTimeout(() => { if (el.viewer.hidden || !S.base) return; if (S.fit) fitPage(); else { computeFit(); scheduleHi(0); } }, 150);
});

/* ---------- Einrichtung / Daten auf dem Gerät ---------- */
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const mb = b => (b / 1048576).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' MB';
const fmtDate = iso => { const d = new Date(iso); return iso && !isNaN(d) ? d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '?'; };
let busy = false;

async function showSetup(msg) {
  $('setup').hidden = false;
  $('iosHint').hidden = !(isIOS && !standalone);
  probePc();
  await refreshState(msg);
}
async function probePc() {           // "Vom PC laden" nur zeigen, wenn der EBS-Server diese App ausliefert
  try {
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 2500);
    const r = await fetch('info', { cache: 'no-store', signal: ctl.signal });
    $('pcCard').hidden = !(r.ok && (await r.json()).datenSize);
  } catch { $('pcCard').hidden = true; }
}
async function refreshState(msg) {
  const st = Store.supported() ? await Store.status().catch(() => null) : null;
  let t;
  if (!st) t = 'Dieser Browser kann keine Daten offline speichern. Bitte Safari (ab iOS 17), Chrome oder Edge verwenden – und die Seite über https öffnen.';
  else if (st.done) t = `✓ Daten auf diesem Gerät · Stand ${fmtDate(st.meta.created)} · PDF ${mb(st.pdfBytes)}, Suchdaten ${mb(st.dataBytes)}`;
  else if (st.pdfBytes || st.dataBytes) t = `Unvollständig (PDF ${mb(st.pdfBytes)}${st.meta ? ' von ' + mb(st.meta.pdfSize) : ''}). „Daten vom PC laden“ setzt fort.`;
  else t = 'Noch keine Daten auf diesem Gerät.';
  $('stateBox').textContent = msg || t;
  $('setupClose').hidden = !(st && st.done);
  $('wipe').hidden = !(st && (st.pdfBytes || st.dataBytes));
  try {
    const e = await navigator.storage.estimate();
    const p = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    $('storeInfo').textContent = `Speicher der App: ${mb(e.usage || 0)} belegt, ca. ${mb(e.quota || 0)} möglich${p ? ' · vor automatischem Löschen geschützt' : ''}.`;
  } catch {}
}
function setBusy(b) {
  busy = b;
  for (const id of ['fromPc', 'pick', 'setupClose', 'wipe']) $(id).disabled = b;
  $('pick').parentElement.classList.toggle('disabled', b);
  if (!b) $('prog').hidden = true;
}
function progress(label, pos, total) {
  $('prog').hidden = false;
  $('progText').textContent = `${label}: ${mb(pos)} von ${mb(total)} (${Math.floor(pos / total * 100)} %)`;
  $('progBar').max = total; $('progBar').value = pos;
}
function releaseData() {                // vor dem Überschreiben: offene Dateien freigeben
  if (!el.viewer.hidden) closeViewer();
  S.pdfP?.then(d => d.destroy()).catch(() => {});
  S.pdfP = null; S.pdfFile = null;
}
async function finishSetup() {
  const b = await Store.openBundle();
  const m = await Store.readMeta();
  await Store.writeMeta({ ...m, created: b.head.created });
  await loadData(b);
  $('setup').hidden = true; $('banner').hidden = true;
}
async function loadFromPc() {
  if (busy) return;
  setBusy(true);
  let wake = null;
  try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  try {
    navigator.storage.persist?.().catch(() => {});
    $('stateBox').textContent = 'Verbinde mit dem PC …';
    let info;
    try { const r = await fetch('info', { cache: 'no-store' }); if (!r.ok) throw 0; info = await r.json(); }
    catch { throw new Error('Der EBS-Server ist nicht erreichbar. Läuft start.cmd auf dem PC, und ist das Gerät im selben WLAN?'); }
    if (!info.datenSize) throw new Error('Auf dem PC fehlt das Datenpaket – dort index_erstellen.cmd ausführen.');
    releaseData();
    const old = await Store.readMeta();
    if (old && (old.pdfSize !== info.pdfSize || old.pdfTime !== info.pdfTime)) await Store.removeFile(Store.PDF);
    if (old && (old.datenSize !== info.datenSize || old.datenTime !== info.datenTime)) await Store.removeFile(Store.DATA);
    await Store.writeMeta({ pdfSize: info.pdfSize, pdfTime: info.pdfTime, datenSize: info.datenSize, datenTime: info.datenTime, source: 'pc' });
    await Store.download('ebs-daten.bin', Store.DATA, info.datenSize, (p, t) => progress('Suchdaten', p, t));
    await Store.download('doc.pdf', Store.PDF, info.pdfSize, (p, t) => progress('Zeichnungen (PDF)', p, t));
    await finishSetup();
  } catch (e) {
    await refreshState('Fehler: ' + (e.message || e));
  } finally {
    setBusy(false);
    try { await wake?.release(); } catch {}
  }
}
async function importPicked(files) {
  if (busy) return;
  const arr = [...files];
  const pdf = arr.find(f => /\.pdf$/i.test(f.name));
  const dat = arr.find(f => /\.bin$/i.test(f.name));
  if (!pdf || !dat) { await refreshState('Bitte beide Dateien zusammen auswählen: die PDF und „ebs-daten.bin“.'); return; }
  setBusy(true);
  try {
    navigator.storage.persist?.().catch(() => {});
    if (dat.size < 1e6) throw new Error(`„${dat.name}“ ist nur ${dat.size.toLocaleString('de-DE')} Bytes groß – vermutlich noch nicht aus OneDrive heruntergeladen. In der OneDrive-App „Offline verfügbar machen“ und erneut wählen.`);
    await Store.checkProtected(dat, 'Die gewählten Dateien');
    await Store.checkProtected(pdf, 'Die gewählten Dateien');
    releaseData();
    await Store.writeMeta({ pdfSize: pdf.size, datenSize: dat.size, source: 'datei' });
    // erst vollständig in den App-Speicher kopieren, dann prüfen (direktes Lesen aus dem Auswahldialog ist unter iOS unzuverlässig)
    await Store.importFile(dat, Store.DATA, (p, t) => progress('Suchdaten', p, t));
    let head;
    try { head = (await Store.openBundle()).head; }
    catch (e) { throw new Error(`${e.message} · ${await Store.describe(dat, 'Gewählt „' + dat.name + '“')}`); }
    await Store.importFile(pdf, Store.PDF, (p, t) => progress('Zeichnungen (PDF)', p, t));
    // Die offizielle Fassung (z. B. EbsPDF_03_2026.pdf) ist anders groß und ggf. passwortgeschützt –
    // geprüft wird deshalb, ob sie sich öffnen lässt und gleich viele Seiten hat wie die Suchdaten.
    $('progText').textContent = 'Prüfe PDF …';
    let pw;
    try { pw = await verifyPdf(await Store.file(Store.PDF), head); }
    catch (e) { await Store.removeFile(Store.PDF); throw e; }
    const m = await Store.readMeta();
    await Store.writeMeta({ ...m, pdfPw: pw, official: !!(head.fileSize && head.fileSize !== pdf.size) });
    await finishSetup();
  } catch (e) {
    await refreshState('Fehler: ' + (e.message || e));
  } finally {
    setBusy(false); $('pick').value = '';
  }
}
/* PDF zur Probe öffnen; bei Passwortschutz nachfragen. Gibt das Passwort zurück ('' ohne Schutz). */
async function verifyPdf(file, head) {
  let pw = '';
  for (let attempt = 0; ; attempt++) {
    const task = pdfjsLib.getDocument({ range: new BlobRangeTransport(file), password: pw || undefined,
      disableAutoFetch: true, disableStream: true, rangeChunkSize: 1 << 19 });
    try {
      const doc = await task.promise;
      const n = doc.numPages;
      await doc.destroy();
      if (head.numPages && n !== head.numPages) {
        throw new Error(`Die PDF hat ${n} Seiten, die Suchdaten gehören zu einer Fassung mit ${head.numPages} Seiten.`);
      }
      return pw;
    } catch (e) {
      task.destroy?.();
      if (e && e.name === 'PasswordException') {
        pw = await askPassword(attempt === 0 ? 'Diese PDF ist mit einem Passwort geschützt.' : 'Das Passwort stimmt nicht – bitte erneut eingeben.');
        if (pw === null) throw new Error('Ohne Passwort lässt sich die PDF nicht öffnen.');
        continue;
      }
      throw e;
    }
  }
}
function askPassword(text) {
  return new Promise(resolve => {
    const box = $('pwBox'), inp = $('pwIn');
    $('pwMsg').textContent = text; inp.value = ''; box.hidden = false; inp.focus();
    const done = v => { box.hidden = true; $('pwOk').onclick = $('pwCancel').onclick = inp.onkeydown = null; resolve(v); };
    $('pwOk').onclick = () => done(inp.value);
    $('pwCancel').onclick = () => done(null);
    inp.onkeydown = e => { if (e.key === 'Enter') done(inp.value); if (e.key === 'Escape') done(null); };
  });
}
async function wipe() {
  if (busy || !confirm('PDF und Suchdaten von diesem Gerät löschen? Danach müssen sie neu geladen werden.')) return;
  releaseData();
  await Store.remove();
  S.pages = []; S.results = []; el.list.textContent = ''; el.status.textContent = 'Keine Daten auf diesem Gerät.';
  await refreshState();
}
function banner(text, label, fn) {
  const b = $('banner'); b.textContent = text + ' ';
  const btn = document.createElement('button'); btn.textContent = label; btn.onclick = fn;
  b.append(btn); b.hidden = false;
}
async function checkUpdate() {
  const m = await Store.readMeta();
  if (!m || m.source !== 'pc') return;
  try {
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 3000);
    const info = await fetch('info', { cache: 'no-store', signal: ctl.signal }).then(r => r.json());
    if (info.datenSize && (info.datenTime !== m.datenTime || info.pdfSize !== m.pdfSize || info.pdfTime !== m.pdfTime)) {
      banner('Neue Daten auf dem PC verfügbar.', 'Jetzt laden', () => { showSetup(); loadFromPc(); });
    }
  } catch { /* offline – kein Problem */ }
}
async function boot() {
  if (!Store.supported()) { el.status.textContent = 'Offline-Speicher nicht verfügbar.'; showSetup(); return; }
  const st = await Store.status().catch(() => null);
  if (!st || !st.done) { el.status.textContent = 'Keine Daten auf diesem Gerät.'; showSetup(); return; }
  try { await loadData(); }
  catch (e) { showSetup('Die gespeicherten Daten konnten nicht gelesen werden: ' + (e.message || e)); return; }
  checkUpdate();
}
$('dataBtn').onclick = () => showSetup();
$('setupClose').onclick = () => { $('setup').hidden = true; };
$('fromPc').onclick = loadFromPc;
$('pick').onchange = e => importPicked(e.target.files);
$('wipe').onclick = wipe;

/* ---------- Start ---------- */
let qT = 0;
const syncClear = () => { $('qClear').hidden = !el.q.value; };
el.q.addEventListener('input', () => { syncClear(); clearTimeout(qT); qT = setTimeout(run, 160); });
$('qClear').onclick = () => { el.q.value = ''; syncClear(); run(); el.q.focus(); };
el.q.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(qT); run(); el.q.blur(); } });
el.sort.addEventListener('change', run);
$('fuzzy').addEventListener('change', () => { try { localStorage.setItem('ebs.fuzzy', $('fuzzy').checked ? '1' : '0'); } catch {} run(); });
try { el.q.value = localStorage.getItem('ebs.q') || ''; if (localStorage.getItem('ebs.fuzzy') === '0') $('fuzzy').checked = false; } catch {}
syncClear();
boot();

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
