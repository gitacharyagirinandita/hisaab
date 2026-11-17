/* Hisaab – Digital Udhar Khata
 * Static, dependency-free app. Ledger data lives in localStorage,
 * payment screenshots in IndexedDB. Balances are always derived from
 * transaction history – never stored.
 */
(function () {
  'use strict';

  // ---------- tiny helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"'`]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;'
  }[c]));
  const uid = () => (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

  const KEY = 'hisaab:data:v1';
  const PKEY = 'hisaab:prefs:v1';
  const BKEY = 'hisaab:backups:v1';

  // ---------- i18n ----------
  const I18N = window.HISAAB_I18N || { en: {} };
  const LOCALES = { en: 'en-IN', hi: 'hi-IN', te: 'te-IN', kn: 'kn-IN' };
  let prefs = loadPrefs();
  function tr(key, vars) {
    const dict = I18N[prefs.lang] || I18N.en;
    let s = (dict && dict[key] != null) ? dict[key] : (I18N.en[key] != null ? I18N.en[key] : key);
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
    return s;
  }

  // ---------- dates (no UTC conversion anywhere) ----------
  const pad = (n) => String(n).padStart(2, '0');
  const localISO = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  function isValidISO(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    if (y < 1900 || y > 2200) return false;
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }
  function todayISO() {
    try {
      const p = new URLSearchParams(location.search).get('today');
      if (p && isValidISO(p.trim())) return p.trim();
    } catch (e) { /* ignore */ }
    return localISO(new Date());
  }
  // Day number from calendar parts – pure arithmetic, timezone independent.
  const dayNum = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
  const daysBetween = (a, b) => Math.round(dayNum(b) - dayNum(a));
  function fmtDate(s) {
    if (!isValidISO(s)) return esc(s);
    try {
      return new Intl.DateTimeFormat(LOCALES[prefs.lang] || 'en-IN', {
        day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
      }).format(new Date(dayNum(s) * 864e5));
    } catch (e) { return s; }
  }
  function normalizeDate(v) {
    if (v == null) return null;
    let s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}([T\s].*)?$/.test(s)) s = s.slice(0, 10); // keep calendar date as written
    else {
      const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/); // DD/MM/YYYY (Indian)
      if (m) s = m[3] + '-' + pad(m[2]) + '-' + pad(m[1]);
    }
    return isValidISO(s) ? s : null;
  }

  // ---------- money (paise integers to avoid float drift) ----------
  const toP = (a) => Math.round(Number(a) * 100);
  function fmtINR(amount) {
    const neg = amount < 0;
    const v = Math.abs(Math.round(amount * 100) / 100);
    const s = v.toLocaleString('en-IN', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
    return (neg ? '-' : '') + '₹' + s;
  }
  const plainAmt = (a) => { const v = Math.round(a * 100) / 100; return v % 1 ? v.toFixed(2) : String(v); };
  function parseAmount(v) {
    const s = String(v == null ? '' : v).replace(/[,\s₹]/g, '').replace(/^rs\.?/i, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
    const n = Number(s);
    return n > 0 && n <= 1e8 ? n : NaN;
  }
  function normalizePhone(v) {
    let d = String(v == null ? '' : v).replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    return /^\d{10}$/.test(d) ? d : null;
  }
  const isMobile = (p) => /^[6-9]\d{9}$/.test(p);

  // ---------- persistence ----------
  function emptyDb() {
    return { app: 'hisaab', version: 1, shop: { name: '', upiId: '' }, customers: [], txns: [], seq: 0, updatedAt: 0 };
  }
  function sanitizeDb(d) {
    const out = emptyDb();
    if (!d || typeof d !== 'object') return out;
    out.shop.name = typeof d.shop?.name === 'string' ? d.shop.name : '';
    out.shop.upiId = typeof d.shop?.upiId === 'string' ? d.shop.upiId : '';
    out.seq = Number(d.seq) || 0;
    out.updatedAt = Number(d.updatedAt) || 0;
    const ids = new Set();
    for (const c of Array.isArray(d.customers) ? d.customers : []) {
      if (!c || !c.id || !normalizePhone(c.phone)) continue;
      ids.add(c.id);
      out.customers.push({
        id: String(c.id), name: String(c.name || ''), phone: normalizePhone(c.phone),
        createdAt: isValidISO(c.createdAt) ? c.createdAt : todayISO(),
        dueDate: isValidISO(c.dueDate) ? c.dueDate : ''
      });
    }
    for (const x of Array.isArray(d.txns) ? d.txns : []) {
      if (!x || !ids.has(x.customerId) || (x.type !== 'credit' && x.type !== 'payment')) continue;
      const amt = Number(x.amount);
      if (!(amt > 0) || !isValidISO(x.date)) continue;
      out.txns.push({
        id: String(x.id || uid()), customerId: x.customerId, type: x.type, amount: amt, date: x.date,
        note: String(x.note || ''), shot: !!x.shot, seq: Number(x.seq) || ++out.seq, createdAt: Number(x.createdAt) || 0
      });
    }
    out.seq = Math.max(out.seq, ...out.txns.map((x) => x.seq), 0);
    return out;
  }
  let storageOk = true;
  function loadDb() {
    let raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { storageOk = false; return emptyDb(); }
    if (!raw) return emptyDb();
    try { return sanitizeDb(JSON.parse(raw)); } catch (e) {
      // Never silently overwrite unreadable data – keep a copy aside.
      try { localStorage.setItem(KEY + ':corrupt-' + Date.now(), raw); } catch (e2) { /* ignore */ }
      setTimeout(() => toast(tr('err_corrupt'), 'error', 8000), 300);
      return emptyDb();
    }
  }
  function persist() {
    db.updatedAt = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify(db)); storageOk = true; return true; } catch (e) {
      storageOk = false; toast(tr('err_storage'), 'error', 7000); return false;
    }
  }
  function commit(mutator) {
    const snap = JSON.stringify(db);
    try { mutator(); } catch (e) { db = JSON.parse(snap); toast(String(e.message || e), 'error'); return false; }
    if (!persist()) { db = JSON.parse(snap); render(); return false; }
    render();
    return true;
  }
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PKEY) || '{}');
      return { lang: ['en', 'hi', 'te', 'kn'].includes(p.lang) ? p.lang : 'en', theme: p.theme === 'dark' || p.theme === 'light' ? p.theme : '' };
    } catch (e) { return { lang: 'en', theme: '' }; }
  }
  function savePrefs() { try { localStorage.setItem(PKEY, JSON.stringify(prefs)); } catch (e) { /* non-critical */ } }
  function getBackups() { try { return JSON.parse(localStorage.getItem(BKEY) || '[]') || []; } catch (e) { return []; } }
  function pushBackup(reason) {
    if (!db.customers.length) return true;
    const list = getBackups();
    list.unshift({ at: Date.now(), reason, shop: db.shop.name, customers: db.customers.length, data: JSON.parse(JSON.stringify(db)) });
    while (list.length > 3) list.pop();
    for (;;) {
      try { localStorage.setItem(BKEY, JSON.stringify(list)); return true; } catch (e) {
        if (list.length <= 1) return false;
        list.pop();
      }
    }
  }

  let db = loadDb();

  // ---------- screenshots (IndexedDB, localStorage fallback) ----------
  const Shots = (() => {
    const mem = new Map();
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((res, rej) => {
        if (!('indexedDB' in window)) { rej(new Error('IndexedDB unavailable')); return; }
        const r = indexedDB.open('hisaab-shots', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('shots');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error('IndexedDB blocked'));
      });
      return dbp;
    }
    async function run(mode, fn) {
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction('shots', mode);
        fn(t.objectStore('shots'));
        t.oncomplete = () => res();
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      });
    }
    return {
      mem,
      async put(id, url) {
        try { await run('readwrite', (s) => s.put(url, id)); } catch (e) {
          localStorage.setItem('hisaab:shot:' + id, url); // may throw → caller handles
        }
        mem.set(id, url);
      },
      async del(id) {
        mem.delete(id);
        try { await run('readwrite', (s) => s.delete(id)); } catch (e) { /* ignore */ }
        try { localStorage.removeItem('hisaab:shot:' + id); } catch (e) { /* ignore */ }
      },
      async clear() {
        const ids = Array.from(mem.keys());
        mem.clear();
        try { await run('readwrite', (s) => s.clear()); } catch (e) { /* ignore */ }
        ids.forEach((id) => { try { localStorage.removeItem('hisaab:shot:' + id); } catch (e) { /* */ } });
      },
      async loadAll() {
        try {
          const d = await open();
          await new Promise((res, rej) => {
            const req = d.transaction('shots', 'readonly').objectStore('shots').openCursor();
            req.onsuccess = () => { const c = req.result; if (c) { mem.set(c.key, c.value); c.continue(); } else res(); };
            req.onerror = () => rej(req.error);
          });
        } catch (e) { /* ignore */ }
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('hisaab:shot:')) mem.set(k.slice(12), localStorage.getItem(k));
          }
        } catch (e) { /* ignore */ }
      }
    };
  })();

  function isImageFile(file) {
    return file && (/^image\//.test(file.type || '') || /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(file.name || ''));
  }
  function readImage(file) {
    return new Promise((res, rej) => {
      if (!file) { res(null); return; }
      if (!isImageFile(file)) { rej(new Error(tr('err_image_type'))); return; }
      if (file.size > 10 * 1024 * 1024) { rej(new Error(tr('err_image_size'))); return; }
      const fr = new FileReader();
      fr.onerror = () => rej(fr.error || new Error(tr('err_image_type')));
      fr.onload = () => {
        const url = fr.result;
        const img = new Image();
        img.onload = () => {
          try {
            const max = 1280;
            let w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h) { res(url); return; }
            if (Math.max(w, h) > max) { const k = max / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k); }
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            const out = c.toDataURL('image/jpeg', 0.82);
            res(out.length < url.length ? out : url);
          } catch (e) { res(url); }
        };
        img.onerror = () => res(url);
        img.src = url;
      };
      fr.readAsDataURL(file);
    });
  }
  function hydrateShots(root = document) {
    $$('img[data-shot]', root).forEach((img) => {
      const u = Shots.mem.get(img.dataset.txn);
      if (u && img.getAttribute('src') !== u) img.src = u;
    });
  }

  // ---------- derived data ----------
  const custById = (id) => db.customers.find((c) => c.id === id);
  const custByPhone = (p) => db.customers.find((c) => c.phone === p);
  const byNewest = (a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : b.seq - a.seq);
  const byOldest = (a, b) => -byNewest(a, b);
  function computeStats() {
    const m = new Map();
    for (const c of db.customers) m.set(c.id, { creditP: 0, paidP: 0, balP: 0, count: 0, lastPay: null, firstTxn: null, lastTxn: null });
    for (const x of db.txns) {
      const s = m.get(x.customerId);
      if (!s) continue;
      s.count++;
      if (x.type === 'credit') s.creditP += toP(x.amount); else {
        s.paidP += toP(x.amount);
        if (!s.lastPay || x.date > s.lastPay) s.lastPay = x.date;
      }
      if (!s.firstTxn || x.date < s.firstTxn) s.firstTxn = x.date;
      if (!s.lastTxn || x.date > s.lastTxn) s.lastTxn = x.date;
    }
    for (const s of m.values()) s.balP = s.creditP - s.paidP;
    return m;
  }
  function totals(S) {
    let out = 0, credit = 0, paid = 0, withBal = 0;
    for (const c of db.customers) {
      const s = S.get(c.id);
      credit += s.creditP; paid += s.paidP;
      if (s.balP > 0) { out += s.balP; withBal++; }
    }
    return { outstanding: out / 100, credit: credit / 100, paid: paid / 100, withBal };
  }
  function overdueList(S, today) {
    const list = [];
    for (const c of db.customers) {
      const s = S.get(c.id);
      if (s.balP <= 0) continue;
      const ref = s.lastPay || s.firstTxn || c.createdAt;
      const days = Math.max(0, daysBetween(ref, today));
      list.push({ c, s, days, neverPaid: !s.lastPay, dueOver: c.dueDate && c.dueDate < today ? daysBetween(c.dueDate, today) : 0 });
    }
    list.sort((a, b) => b.days - a.days || b.s.balP - a.s.balP || a.c.name.localeCompare(b.c.name));
    return list;
  }

  // ---------- WhatsApp / UPI ----------
  const UPI_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,63}$/;
  function upiLink(amount) {
    const id = (db.shop.upiId || '').trim();
    if (!id || !UPI_RE.test(id) || !(amount > 0)) return '';
    // id is validated by UPI_RE (only [A-Za-z0-9._-@]) so it is URL-safe as-is
    return 'upi://pay?pa=' + id + '&pn=' + encodeURIComponent(db.shop.name || 'Shop') +
      '&am=' + amount.toFixed(2) + '&cu=INR&tn=' + encodeURIComponent('Hisaab dues');
  }
  function reminderMessage(c, balance) {
    const shop = db.shop.name ? '\n\n- ' + db.shop.name : '';
    if (balance > 0) {
      let msg = tr('wa_hello', { name: c.name }) + '\n\n' + tr('wa_balance', { amount: plainAmt(balance) }) + '\n\n' + tr('wa_kindly');
      const link = upiLink(balance);
      if (link) msg += '\n\n' + tr('wa_upi', { upi: db.shop.upiId.trim() }) + '\n' + link;
      return msg + '\n\n' + tr('wa_thanks') + shop;
    }
    if (balance < 0) return tr('wa_hello', { name: c.name }) + '\n\n' + tr('wa_advance', { amount: plainAmt(-balance) }) + '\n\n' + tr('wa_thanks') + shop;
    return tr('wa_hello', { name: c.name }) + '\n\n' + tr('wa_settled') + '\n\n' + tr('wa_thanks') + shop;
  }
  const waUrl = (c, balance) => 'https://wa.me/91' + c.phone + '?text=' + encodeURIComponent(reminderMessage(c, balance));

  // ---------- icons ----------
  const ICON = {
    home: '<svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    wa: '<svg viewBox="0 0 24 24" class="fill"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.4.1-.2 0-.3 0-.4l-.8-1.9c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.1 5.1 0 0 0 1.1 2.7 11.6 11.6 0 0 0 4.5 3.9c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.2 2.2 2.2 0 0 0 .1-1.3c0-.1-.2-.2-.5-.3z"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M7 17 17 7M8 7h9v9"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M17 7 7 17M16 17H7V8"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    camera: '<svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
    upload: '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    print: '<svg viewBox="0 0 24 24"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z"/></svg>',
    phone: '<svg viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    chart: '<svg viewBox="0 0 24 24"><path d="M3 3v18h18M7 15l4-4 3 3 5-6"/></svg>'
  };
  const initials = (n) => (String(n).trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('') || '?').toUpperCase();
  function avatarHue(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }

  // ---------- UI primitives ----------
  function toast(msg, kind = 'ok', ms = 3200) {
    const root = $('#toast-root');
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.textContent = msg;
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
  }
  let sheetCleanup = null;
  function openSheet(html, { center = false, onClose } = {}) {
    const root = $('#sheet-root');
    root.innerHTML = '<div class="sheet-backdrop" data-close></div><div class="sheet' + (center ? ' center' : '') +
      '" role="dialog" aria-modal="true">' + html + '</div>';
    root.hidden = false;
    document.body.classList.add('no-scroll');
    sheetCleanup = onClose || null;
    const first = root.querySelector('[autofocus]') || root.querySelector('input:not([type=hidden]):not([type=file]),select,textarea,button');
    setTimeout(() => first && first.focus(), 30);
    return root.querySelector('.sheet');
  }
  function closeSheet() {
    const root = $('#sheet-root');
    if (root.hidden) return;
    root.hidden = true; root.innerHTML = '';
    document.body.classList.remove('no-scroll');
    const cb = sheetCleanup; sheetCleanup = null;
    if (cb) cb();
  }
  function confirmDialog({ title, message, ok, danger = true }) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; closeSheet(); resolve(v); };
      const el = openSheet(
        '<h2 class="sheet-title">' + esc(title) + '</h2><p class="muted">' + esc(message) + '</p>' +
        '<div class="btn-row"><button type="button" class="btn ghost" id="confirm-cancel">' + esc(tr('cancel')) + '</button>' +
        '<button type="button" class="btn ' + (danger ? 'danger' : 'primary') + '" id="confirm-ok">' + esc(ok || tr('confirm')) + '</button></div>',
        { center: true, onClose: () => finish(false) });
      el.querySelector('#confirm-ok').addEventListener('click', () => finish(true));
      el.querySelector('#confirm-cancel').addEventListener('click', () => finish(false));
      setTimeout(() => el.querySelector('#confirm-cancel').focus(), 40);
    });
  }
  function download(name, content, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  const csvCell = (v) => {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; // spreadsheet formula-injection guard
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const toCSV = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const fileSlug = (s) => (String(s || 'hisaab').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'hisaab');

  // ---------- routing ----------
  function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const parts = h.split('/');
    if (parts[0] === 'c' && parts[1]) return { name: 'customer', id: decodeURIComponent(parts[1]) };
    if (parts[0] === 'settings') return { name: 'settings' };
    if (parts[0] === 'import') return { name: 'home', focus: 'import' };
    return { name: 'home' };
  }
  const go = (hash) => { if (location.hash !== hash) location.hash = hash; else render(); };

  // ---------- shared fragments ----------
  function entryForm({ customerId = '', withSelect = false, type = 'credit' } = {}) {
    const today = todayISO();
    const opts = db.customers.slice().sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => '<option value="' + esc(c.id) + '"' + (c.id === customerId ? ' selected' : '') + '>' + esc(c.name) + ' · ' + c.phone + '</option>').join('');
    return '<form id="entry-form" class="entry-form" novalidate autocomplete="off">' +
      (withSelect
        ? '<label class="field"><span>' + esc(tr('customer')) + '</span><select name="customer" id="entry-customer" required>' +
          '<option value="">' + esc(tr('choose_customer')) + '</option>' + opts + '</select></label>'
        : '<input type="hidden" name="customer" value="' + esc(customerId) + '">') +
      '<div class="seg" role="radiogroup" aria-label="' + esc(tr('entry_type')) + '">' +
        '<label class="seg-opt credit"><input type="radio" name="type" value="credit" id="type-credit"' + (type === 'credit' ? ' checked' : '') + '><span>' + esc(tr('credit_given')) + '</span></label>' +
        '<label class="seg-opt payment"><input type="radio" name="type" value="payment" id="type-payment"' + (type === 'payment' ? ' checked' : '') + '><span>' + esc(tr('payment_received')) + '</span></label>' +
      '</div>' +
      '<div class="grid2">' +
        '<label class="field"><span>' + esc(tr('amount')) + ' (₹)</span><input name="amount" id="entry-amount" inputmode="decimal" placeholder="0" required class="amount-input"></label>' +
        '<label class="field"><span>' + esc(tr('date')) + '</span><input type="date" name="date" id="entry-date" value="' + today + '" required></label>' +
      '</div>' +
      '<label class="field"><span>' + esc(tr('note')) + '</span><input name="note" id="entry-note" maxlength="120" placeholder="' + esc(tr('note_ph')) + '"></label>' +
      '<div class="shot-field">' +
        '<label class="shot-pick" for="shot-input">' + ICON.camera + '<span>' + esc(tr('attach_screenshot')) + '</span></label>' +
        '<input type="file" id="shot-input" name="shot" accept="image/*" class="file-input">' +
        '<div class="shot-preview" id="shot-preview-wrap" hidden><img id="shot-preview" alt="' + esc(tr('preview')) + '"><button type="button" class="icon-btn sm" data-action="clear-shot" aria-label="' + esc(tr('remove')) + '">' + ICON.x + '</button></div>' +
        '<small class="muted">' + esc(tr('screenshot_hint')) + '</small>' +
      '</div>' +
      '<p class="form-error" role="alert" hidden></p>' +
      '<button type="submit" class="btn primary block" id="entry-save">' + esc(tr('save_entry')) + '</button>' +
    '</form>';
  }
  function txnItem(x, { showName = false, after = null, editable = false } = {}) {
    const c = custById(x.customerId);
    const isC = x.type === 'credit';
    const shotUrl = Shots.mem.get(x.id) || BLANK;
    const title = showName ? esc(c ? c.name : '?') : esc(x.note || (isC ? tr('credit_given') : tr('payment_received')));
    const sub = (showName && x.note ? esc(x.note) + ' · ' : '') + fmtDate(x.date) +
      (after != null ? ' · ' + esc(tr('bal_short')) + ' ' + fmtINR(after) : '');
    return '<li class="txn ' + x.type + '" data-txn="' + esc(x.id) + '" data-type="' + x.type + '" data-amount="' + x.amount + '" data-date="' + x.date + '">' +
      '<div class="txn-ico">' + (isC ? ICON.up : ICON.down) + '</div>' +
      '<div class="txn-body">' +
        (showName && c ? '<a class="txn-title" href="#/c/' + encodeURIComponent(c.id) + '">' + title + '</a>' : '<div class="txn-title">' + title + '</div>') +
        '<div class="txn-meta">' + '<span class="pill ' + x.type + '">' + esc(isC ? tr('credit') : tr('payment')) + '</span> ' + sub + '</div>' +
        (x.shot ? '<button type="button" class="shot-thumb" data-action="view-shot" data-id="' + esc(x.id) + '" aria-label="' + esc(tr('view_screenshot')) + '"><img data-shot data-txn="' + esc(x.id) + '" src="' + esc(shotUrl) + '" alt="' + esc(tr('payment_screenshot')) + '" width="52" height="52"></button>' : '') +
      '</div>' +
      '<div class="txn-side"><div class="txn-amt">' + (isC ? '+ ' : '− ') + fmtINR(x.amount) + '</div>' +
        (editable ? '<div class="txn-actions"><button type="button" class="icon-btn sm" data-action="edit-txn" data-id="' + esc(x.id) + '" aria-label="' + esc(tr('edit')) + '">' + ICON.edit + '</button>' +
          '<button type="button" class="icon-btn sm danger" data-action="delete-txn" data-id="' + esc(x.id) + '" aria-label="' + esc(tr('delete')) + '">' + ICON.trash + '</button></div>' : '') +
      '</div></li>';
  }
  function balClass(p) { return p > 0 ? 'due' : p < 0 ? 'adv' : 'zero'; }

  // ---------- views ----------
  let searchQuery = '';
  let lastQuickCustomer = '';
  let importMsg = null;

  function renderHome(focus) {
    const S = computeStats();
    const today = todayISO();
    const T = totals(S);
    const customers = db.customers.slice().sort((a, b) => S.get(b.id).balP - S.get(a.id).balP || a.name.localeCompare(b.name));
    const overdue = overdueList(S, today);
    const recent = db.txns.slice().sort(byNewest).slice(0, 8);
    const rate = T.credit > 0 ? Math.min(100, Math.round((T.paid / T.credit) * 100)) : 0;
    const month = today.slice(0, 7);
    let mCredit = 0, mPaid = 0;
    for (const x of db.txns) if (x.date.slice(0, 7) === month) { if (x.type === 'credit') mCredit += toP(x.amount); else mPaid += toP(x.amount); }
    const top = overdue.slice().sort((a, b) => b.s.balP - a.s.balP)[0];

    let h = '';
    h += '<section class="hero">' +
      '<div class="hero-top"><span class="hero-shop">' + esc(db.shop.name || tr('my_shop')) + '</span><span class="hero-date">' + ICON.clock + fmtDate(today) + '</span></div>' +
      '<div class="hero-label">' + esc(tr('total_outstanding')) + '</div>' +
      '<div id="total-outstanding" class="hero-amount" data-amount="' + T.outstanding + '">' + fmtINR(T.outstanding) + '</div>' +
      '<div class="hero-sub">' + esc(tr('to_collect_from', { n: T.withBal })) + '</div>' +
      '</section>';
    h += '<section class="stats">' +
      '<div class="stat"><span class="stat-label">' + esc(tr('customers')) + '</span><span class="stat-val" id="stat-customers">' + db.customers.length + '</span></div>' +
      '<div class="stat"><span class="stat-label">' + esc(tr('total_credit')) + '</span><span class="stat-val due" id="stat-credit">' + fmtINR(T.credit) + '</span></div>' +
      '<div class="stat"><span class="stat-label">' + esc(tr('total_received')) + '</span><span class="stat-val ok" id="stat-paid">' + fmtINR(T.paid) + '</span></div>' +
      '<div class="stat"><span class="stat-label">' + esc(tr('collection_rate')) + '</span><span class="stat-val">' + rate + '%</span><span class="meter"><i style="width:' + rate + '%"></i></span></div>' +
      '</section>';
    h += '<div class="action-row">' +
      '<button type="button" class="btn primary" data-action="add-customer" id="add-customer-btn">' + ICON.plus + '<span>' + esc(tr('add_customer')) + '</span></button>' +
      '<a class="btn ghost" href="#import-section" data-action="goto-import">' + ICON.upload + '<span>' + esc(tr('import')) + '</span></a>' +
      '<button type="button" class="btn ghost" data-action="export-csv" id="export-csv">' + ICON.download + '<span>CSV</span></button>' +
      '</div>';

    // Customers
    h += '<section class="card" id="customers-section"><div class="card-head"><h2>' + esc(tr('customers')) + ' <span class="count">' + db.customers.length + '</span></h2></div>' +
      '<div class="search"><span class="search-ico">' + ICON.search + '</span><input type="search" id="search" placeholder="' + esc(tr('search_ph')) + '" value="' + esc(searchQuery) + '" aria-label="' + esc(tr('search_ph')) + '" enterkeyhint="search"></div>';
    if (!customers.length) {
      h += '<div class="empty"><div class="empty-ico">' + ICON.home + '</div><p><b>' + esc(tr('empty_title')) + '</b></p><p class="muted">' + esc(tr('empty_body')) + '</p>' +
        '<button type="button" class="btn primary" data-action="add-customer">' + esc(tr('add_customer')) + '</button></div>';
    } else {
      h += '<ul class="cust-list" id="customer-list">';
      for (const c of customers) {
        const s = S.get(c.id);
        const bal = s.balP / 100;
        const dueChip = c.dueDate && s.balP > 0 ? (c.dueDate < today
          ? '<span class="chip warn">' + esc(tr('due_passed')) + '</span>'
          : '<span class="chip">' + esc(tr('due_on', { date: fmtDate(c.dueDate) })) + '</span>') : '';
        h += '<li class="cust-row" data-customer="' + c.phone + '" data-name="' + esc(c.name.toLowerCase()) + '">' +
          '<a class="cust-main" href="#/c/' + encodeURIComponent(c.id) + '">' +
            '<span class="avatar" style="--h:' + avatarHue(c.phone) + '">' + esc(initials(c.name)) + '</span>' +
            '<span class="cust-text"><span class="cust-name">' + esc(c.name) + '</span><span class="cust-phone">' + c.phone + (s.lastTxn ? ' · ' + fmtDate(s.lastTxn) : '') + '</span>' + dueChip + '</span>' +
          '</a>' +
          '<div class="cust-side"><span class="bal ' + balClass(s.balP) + '" data-balance="' + bal + '">' + fmtINR(bal) + '</span>' +
          '<a class="remind' + (s.balP > 0 ? '' : ' muted-remind') + '" data-remind="' + c.phone + '" href="' + esc(waUrl(c, bal)) + '" target="_blank" rel="noopener noreferrer" aria-label="' + esc(tr('remind_on_wa', { name: c.name })) + '">' + ICON.wa + '<span>' + esc(s.balP > 0 ? tr('remind') : tr('settled')) + '</span></a></div>' +
          '</li>';
      }
      h += '</ul><p class="muted center" id="no-results" hidden>' + esc(tr('no_results')) + '</p>';
    }
    h += '</section>';

    // Quick entry
    h += '<section class="card" id="quick-entry"><div class="card-head"><h2>' + esc(tr('quick_entry')) + '</h2></div>' +
      (db.customers.length ? entryForm({ customerId: lastQuickCustomer, withSelect: true }) : '<p class="muted">' + esc(tr('quick_entry_empty')) + '</p>' + entryForm({ withSelect: true })) +
      '</section>';

    // Overdue
    h += '<section class="card" id="overdue-section"><div class="card-head"><h2>' + esc(tr('overdue')) + ' <span class="count warn">' + overdue.length + '</span></h2><small class="muted">' + esc(tr('overdue_hint')) + '</small></div>';
    if (!overdue.length) h += '<p class="muted">' + esc(tr('overdue_none')) + '</p>';
    else {
      h += '<ol class="overdue-list" id="overdue-list">';
      for (const o of overdue) {
        h += '<li class="overdue-row" data-overdue="' + o.c.phone + '" data-days="' + o.days + '"><a href="#/c/' + encodeURIComponent(o.c.id) + '">' +
          '<span class="days ' + (o.days >= 30 ? 'hot' : o.days >= 15 ? 'warm' : '') + '"><b>' + o.days + '</b><small>' + esc(tr('days')) + '</small></span>' +
          '<span class="od-text"><span class="cust-name">' + esc(o.c.name) + '</span><span class="muted small">' +
          esc(o.neverPaid ? tr('never_paid') : tr('last_paid_on', { date: fmtDate(o.s.lastPay) })) +
          (o.dueOver ? ' · ' + esc(tr('due_passed')) : '') + '</span></span>' +
          '<span class="bal due">' + fmtINR(o.s.balP / 100) + '</span></a></li>';
      }
      h += '</ol>';
    }
    h += '</section>';

    // Insights
    h += '<section class="card" id="insights"><div class="card-head"><h2>' + esc(tr('insights')) + '</h2></div><div class="insights">' +
      '<div class="ins"><span class="muted small">' + esc(tr('top_due')) + '</span><b>' + (top ? esc(top.c.name) : '—') + '</b><span class="due">' + (top ? fmtINR(top.s.balP / 100) : '') + '</span></div>' +
      '<div class="ins"><span class="muted small">' + esc(tr('with_balance')) + '</span><b>' + T.withBal + ' / ' + db.customers.length + '</b></div>' +
      '<div class="ins"><span class="muted small">' + esc(tr('month_credit')) + '</span><b class="due">' + fmtINR(mCredit / 100) + '</b></div>' +
      '<div class="ins"><span class="muted small">' + esc(tr('month_received')) + '</span><b class="ok">' + fmtINR(mPaid / 100) + '</b></div>' +
      '</div></section>';

    // Recent
    h += '<section class="card" id="recent-section"><div class="card-head"><h2>' + esc(tr('recent')) + '</h2></div>';
    h += recent.length ? '<ul class="txn-list" id="recent-list">' + recent.map((x) => txnItem(x, { showName: true })).join('') + '</ul>' : '<p class="muted">' + esc(tr('no_txns')) + '</p>';
    h += '</section>';

    // Import
    h += '<section class="card" id="import-section"><div class="card-head"><h2>' + esc(tr('import_title')) + '</h2></div>' +
      '<p class="muted small">' + esc(tr('import_help')) + '</p>' +
      '<label class="sr-only" for="import-box">' + esc(tr('import_title')) + '</label>' +
      '<textarea id="import-box" rows="6" spellcheck="false" placeholder=\'{"shop": "...", "customers": [{"name": "...", "phone": "9xxxxxxxxx"}], "entries": [{"phone": "9xxxxxxxxx", "type": "credit", "amount": 100, "date": "2026-11-01", "note": "..."}]}\'></textarea>' +
      '<div class="import-opts"><label class="field inline"><span>' + esc(tr('import_mode')) + '</span><select id="import-mode">' +
        '<option value="replace">' + esc(tr('mode_replace')) + '</option><option value="merge">' + esc(tr('mode_merge')) + '</option></select></label></div>' +
      '<div class="btn-row wrap"><button type="button" class="btn primary" id="import-go">' + ICON.upload + '<span>' + esc(tr('import_btn')) + '</span></button>' +
      '<label class="btn ghost" for="import-file">' + ICON.upload + '<span>' + esc(tr('upload_json')) + '</span></label>' +
      '<input type="file" id="import-file" accept=".json,application/json" class="file-input"></div>' +
      '<div id="import-result" class="import-result' + (importMsg ? ' ' + importMsg.kind : '') + '" role="status"' + (importMsg ? '' : ' hidden') + '>' + (importMsg ? importMsg.html : '') + '</div>' +
      '</section>';
    return h;
  }

  function renderCustomer(c) {
    const S = computeStats();
    const s = S.get(c.id);
    const bal = s.balP / 100;
    const today = todayISO();
    const list = db.txns.filter((x) => x.customerId === c.id);
    const run = new Map();
    let acc = 0;
    for (const x of list.slice().sort(byOldest)) { acc += x.type === 'credit' ? toP(x.amount) : -toP(x.amount); run.set(x.id, acc / 100); }
    const sorted = list.sort(byNewest);
    let due = '';
    if (c.dueDate && s.balP > 0) {
      const d = daysBetween(today, c.dueDate);
      due = '<span class="chip ' + (d < 0 ? 'warn' : '') + '">' + esc(d < 0 ? tr('overdue_by', { n: -d }) : d === 0 ? tr('due_today') : tr('due_in', { n: d })) + ' · ' + fmtDate(c.dueDate) + '</span>';
    }
    const lastPay = s.lastPay ? tr('last_paid_on', { date: fmtDate(s.lastPay) }) + ' (' + tr('days_ago', { n: daysBetween(s.lastPay, today) }) + ')' : (s.count ? tr('never_paid') : '');
    let h = '<div class="page-head"><a href="#/" class="icon-btn" aria-label="' + esc(tr('back')) + '">' + ICON.back + '</a><h1 class="page-title">' + esc(tr('account')) + '</h1>' +
      '<div class="head-actions"><button type="button" class="icon-btn" data-action="edit-customer" data-id="' + esc(c.id) + '" aria-label="' + esc(tr('edit_customer')) + '">' + ICON.edit + '</button>' +
      '<button type="button" class="icon-btn danger" data-action="delete-customer" data-id="' + esc(c.id) + '" aria-label="' + esc(tr('delete_customer')) + '">' + ICON.trash + '</button></div></div>';
    h += '<section class="acct" data-customer-page="' + c.phone + '">' +
      '<div class="acct-id"><span class="avatar lg" style="--h:' + avatarHue(c.phone) + '">' + esc(initials(c.name)) + '</span><div><h2 class="acct-name" id="account-name">' + esc(c.name) + '</h2>' +
      '<a class="acct-phone" href="tel:+91' + c.phone + '">' + ICON.phone + '<span id="account-phone">' + c.phone + '</span></a>' + (due ? '<div>' + due + '</div>' : '') + '</div></div>' +
      '<div class="acct-bal"><span class="hero-label">' + esc(bal >= 0 ? tr('outstanding') : tr('advance')) + '</span><span id="account-balance" class="acct-amt ' + balClass(s.balP) + '" data-amount="' + bal + '">' + fmtINR(bal) + '</span>' +
      (lastPay ? '<span class="muted small">' + esc(lastPay) + '</span>' : '') + '</div>' +
      '<div class="acct-stats"><div><span class="muted small">' + esc(tr('total_credit')) + '</span><b class="due" id="account-credit">' + fmtINR(s.creditP / 100) + '</b></div>' +
      '<div><span class="muted small">' + esc(tr('total_received')) + '</span><b class="ok" id="account-paid">' + fmtINR(s.paidP / 100) + '</b></div></div>' +
      '</section>';
    h += '<div class="action-grid">' +
      '<button type="button" class="btn credit" id="btn-add-credit" data-action="focus-entry" data-type="credit">' + ICON.up + '<span>' + esc(tr('add_credit')) + '</span></button>' +
      '<button type="button" class="btn payment" id="btn-add-payment" data-action="focus-entry" data-type="payment">' + ICON.down + '<span>' + esc(tr('add_payment')) + '</span></button>' +
      '<a class="btn wa' + (s.balP > 0 ? '' : ' muted-remind') + '" data-remind="' + c.phone + '" href="' + esc(waUrl(c, bal)) + '" target="_blank" rel="noopener noreferrer">' + ICON.wa + '<span>' + esc(s.balP > 0 ? tr('wa_reminder') : tr('wa_message')) + '</span></a>' +
      '<button type="button" class="btn ghost" data-action="statement" data-id="' + esc(c.id) + '" id="btn-statement">' + ICON.download + '<span>' + esc(tr('statement')) + '</span></button>' +
      '</div>';
    if (s.balP <= 0) h += '<p class="note-line muted small">' + esc(tr('no_reminder_needed')) + '</p>';
    h += '<section class="card" id="entry-card"><div class="card-head"><h2 id="entry-heading">' + esc(tr('new_entry')) + '</h2></div>' + entryForm({ customerId: c.id }) + '</section>';
    h += '<section class="card"><div class="card-head"><h2>' + esc(tr('history')) + ' <span class="count">' + sorted.length + '</span></h2>' +
      '<button type="button" class="btn ghost sm" data-action="print-statement" data-id="' + esc(c.id) + '">' + ICON.print + '<span>' + esc(tr('print')) + '</span></button></div>';
    h += sorted.length ? '<ul class="txn-list" id="txn-list">' + sorted.map((x) => txnItem(x, { after: run.get(x.id), editable: true })).join('') + '</ul>'
      : '<p class="muted">' + esc(tr('no_txns_customer')) + '</p>';
    h += '<p class="muted small">' + esc(tr('customer_since', { date: fmtDate(c.createdAt) })) + '</p></section>';
    return h;
  }

  function renderSettings() {
    const backups = getBackups();
    let h = '<div class="page-head"><a href="#/" class="icon-btn" aria-label="' + esc(tr('back')) + '">' + ICON.back + '</a><h1 class="page-title">' + esc(tr('settings')) + '</h1></div>';
    h += '<section class="card"><div class="card-head"><h2>' + esc(tr('shop_details')) + '</h2></div>' +
      '<form id="shop-form" novalidate>' +
      '<label class="field"><span>' + esc(tr('shop_name')) + '</span><input name="shopName" id="shop-name" maxlength="80" value="' + esc(db.shop.name) + '" placeholder="' + esc(tr('shop_name_ph')) + '"></label>' +
      '<label class="field"><span>' + esc(tr('upi_id')) + '</span><input name="upiId" id="upi-id" maxlength="120" value="' + esc(db.shop.upiId) + '" placeholder="yourname@okbank" autocapitalize="off" spellcheck="false"></label>' +
      '<small class="muted">' + esc(tr('upi_hint')) + '</small>' +
      '<p class="form-error" role="alert" hidden></p>' +
      '<button class="btn primary block" type="submit" id="shop-save">' + esc(tr('save')) + '</button></form></section>';
    h += '<section class="card"><div class="card-head"><h2>' + esc(tr('appearance')) + '</h2></div>' +
      '<label class="field"><span>' + esc(tr('language')) + '</span><select id="settings-lang">' +
      [['en', 'English'], ['hi', 'हिंदी (Hindi)'], ['te', 'తెలుగు (Telugu)'], ['kn', 'ಕನ್ನಡ (Kannada)']].map(([v, l]) => '<option value="' + v + '"' + (prefs.lang === v ? ' selected' : '') + '>' + l + '</option>').join('') +
      '</select></label>' +
      '<div class="seg" role="radiogroup" aria-label="' + esc(tr('theme')) + '">' +
      '<label class="seg-opt"><input type="radio" name="theme" value="light"' + (curTheme() === 'light' ? ' checked' : '') + '><span>' + ICON.sun + esc(tr('light')) + '</span></label>' +
      '<label class="seg-opt"><input type="radio" name="theme" value="dark"' + (curTheme() === 'dark' ? ' checked' : '') + '><span>' + ICON.moon + esc(tr('dark')) + '</span></label></div></section>';
    h += '<section class="card"><div class="card-head"><h2>' + esc(tr('data_backup')) + '</h2></div>' +
      '<div class="stack">' +
      '<button type="button" class="btn ghost block" data-action="export-csv" id="export-csv">' + ICON.download + '<span>' + esc(tr('export_ledger_csv')) + '</span></button>' +
      '<button type="button" class="btn ghost block" data-action="export-balances">' + ICON.download + '<span>' + esc(tr('export_balances_csv')) + '</span></button>' +
      '<button type="button" class="btn ghost block" data-action="backup" id="backup-download">' + ICON.download + '<span>' + esc(tr('backup_json')) + '</span></button>' +
      '<label class="btn ghost block" for="restore-file">' + ICON.upload + '<span>' + esc(tr('restore_json')) + '</span></label>' +
      '<input type="file" id="restore-file" accept=".json,application/json" class="file-input">' +
      '<a class="btn ghost block" href="#/import">' + ICON.upload + '<span>' + esc(tr('import_title')) + '</span></a>' +
      '</div>';
    if (backups.length) {
      h += '<h3 class="sub-h">' + esc(tr('auto_backups')) + '</h3><ul class="backup-list">' + backups.map((b, i) =>
        '<li><span><b>' + esc(b.shop || tr('my_shop')) + '</b><small class="muted"> · ' + b.customers + ' ' + esc(tr('customers')) + ' · ' +
        esc(new Date(b.at).toLocaleString(LOCALES[prefs.lang])) + '</small></span><button type="button" class="btn ghost sm" data-action="restore-backup" data-i="' + i + '">' + esc(tr('restore')) + '</button></li>').join('') + '</ul>';
    }
    h += '<p class="muted small">' + esc(tr('storage_note')) + '</p></section>';
    h += '<section class="card danger-zone"><div class="card-head"><h2>' + esc(tr('danger_zone')) + '</h2></div>' +
      '<button type="button" class="btn danger block" data-action="clear-all">' + ICON.trash + '<span>' + esc(tr('clear_all')) + '</span></button></section>';
    h += '<p class="muted small center">Hisaab · ' + esc(tr('made_for')) + '</p>';
    return h;
  }

  // ---------- render ----------
  const curTheme = () => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  function applyChrome() {
    document.documentElement.lang = prefs.lang;
    $$('[data-i18n]').forEach((el) => { el.textContent = tr(el.dataset.i18n); });
    $$('[data-icon]').forEach((el) => { if (!el.firstChild) el.innerHTML = ICON[el.dataset.icon] || ''; });
    const ls = $('#lang-select'); if (ls) ls.value = prefs.lang;
    const tt = $('#theme-toggle');
    if (tt) { tt.innerHTML = curTheme() === 'dark' ? ICON.sun : ICON.moon; tt.setAttribute('aria-label', tr(curTheme() === 'dark' ? 'to_light' : 'to_dark')); }
    $('.nav-add')?.setAttribute('aria-label', tr('add_customer'));
    document.title = 'Hisaab – ' + tr('tagline');
  }
  function render() {
    applyChrome();
    const r = route();
    const v = $('#view');
    let html;
    if (r.name === 'customer') {
      const c = custById(r.id) || custByPhone(r.id);
      if (!c) { location.replace('#/'); return; }
      html = renderCustomer(c);
    } else if (r.name === 'settings') html = renderSettings();
    else html = renderHome();
    v.innerHTML = html;
    v.dataset.view = r.name;
    $$('.bottom-nav [data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === r.name));
    if (r.name === 'home') applySearch();
    hydrateShots(v);
    pendingShot = null;
    if (r.focus === 'import') setTimeout(() => $('#import-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }

  function applySearch() {
    const q = searchQuery.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    let shown = 0;
    $$('#customer-list .cust-row').forEach((row) => {
      const match = !q || row.dataset.name.includes(q) || (digits.length > 0 && row.dataset.customer.includes(digits));
      row.hidden = !match;
      if (match) shown++;
    });
    const nr = $('#no-results');
    if (nr) nr.hidden = shown > 0 || !q;
  }

  // ---------- actions ----------
  let pendingShot = null;

  function showFormError(form, msg) {
    const e = form.querySelector('.form-error');
    if (!e) { toast(msg, 'error'); return; }
    e.textContent = msg; e.hidden = !msg;
  }

  async function submitEntry(form) {
    const f = form.elements;
    const cid = f.customer.value;
    const type = f.type.value === 'payment' ? 'payment' : 'credit';
    const amount = parseAmount(f.amount.value);
    const date = f.date.value;
    const note = f.note.value.trim().replace(/\s+/g, ' ').slice(0, 120);
    const c = custById(cid);
    if (!c) return showFormError(form, tr('err_choose_customer'));
    if (!(amount > 0)) { f.amount.focus(); return showFormError(form, tr('err_amount')); }
    if (!isValidISO(date)) return showFormError(form, tr('err_date'));
    showFormError(form, '');
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    // Picked file that hasn't been processed yet (e.g. very fast submit)
    const fileInput = form.querySelector('#shot-input');
    if (!pendingShot && fileInput && fileInput.files && fileInput.files[0]) {
      try { pendingShot = await readImage(fileInput.files[0]); } catch (e) { btn.disabled = false; return showFormError(form, e.message); }
    }
    const id = uid();
    let shot = false;
    if (pendingShot) {
      try { await Shots.put(id, pendingShot); shot = true; } catch (e) { toast(tr('err_shot_save'), 'error'); }
    }
    if (form.closest('#quick-entry')) lastQuickCustomer = cid;
    const ok = commit(() => {
      db.txns.push({ id, customerId: cid, type, amount, date, note, shot, seq: ++db.seq, createdAt: Date.now() });
    });
    if (ok) toast(tr(type === 'credit' ? 'toast_credit' : 'toast_payment', { amount: fmtINR(amount), name: c.name }));
    else { btn.disabled = false; if (shot) Shots.del(id); }
  }

  function customerSheet(c) {
    const isNew = !c;
    const el = openSheet(
      '<h2 class="sheet-title">' + esc(tr(isNew ? 'add_customer' : 'edit_customer')) + '</h2>' +
      '<form id="customer-form" novalidate autocomplete="off">' +
      '<label class="field"><span>' + esc(tr('name')) + '</span><input name="name" id="cust-name" maxlength="60" required value="' + esc(c ? c.name : '') + '" autofocus></label>' +
      '<label class="field"><span>' + esc(tr('mobile')) + '</span><div class="prefix-input"><span>+91</span><input name="phone" id="cust-phone" inputmode="numeric" maxlength="14" required value="' + esc(c ? c.phone : '') + '" placeholder="98XXXXXXXX"></div></label>' +
      (isNew ? '<label class="field"><span>' + esc(tr('opening_balance')) + '</span><input name="opening" id="cust-opening" inputmode="decimal" placeholder="0"></label>' : '') +
      '<label class="field"><span>' + esc(tr('due_date')) + '</span><input type="date" name="dueDate" id="cust-due" value="' + esc(c ? c.dueDate : '') + '"></label>' +
      '<p class="form-error" role="alert" hidden></p>' +
      '<div class="btn-row"><button type="button" class="btn ghost" data-close>' + esc(tr('cancel')) + '</button><button type="submit" class="btn primary" id="cust-save">' + esc(tr('save')) + '</button></div>' +
      '</form>');
    el.querySelector('#customer-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const form = ev.target, f = form.elements;
      const name = f.name.value.trim().replace(/\s+/g, ' ');
      const raw = f.phone.value.trim();
      const phone = normalizePhone(raw);
      const dueDate = f.dueDate.value;
      if (name.length < 2) return showFormError(form, tr('err_name'));
      if (!phone || !isMobile(phone)) return showFormError(form, tr('err_phone'));
      const dup = custByPhone(phone);
      if (dup && (!c || dup.id !== c.id)) return showFormError(form, tr('err_dup_phone', { name: dup.name }));
      if (dueDate && !isValidISO(dueDate)) return showFormError(form, tr('err_date'));
      let opening = 0;
      if (isNew && f.opening.value.trim()) {
        opening = parseAmount(f.opening.value);
        if (!(opening > 0)) return showFormError(form, tr('err_amount'));
      }
      let newId = null;
      const ok = commit(() => {
        if (isNew) {
          newId = uid();
          db.customers.push({ id: newId, name, phone, createdAt: todayISO(), dueDate: dueDate || '' });
          if (opening > 0) db.txns.push({ id: uid(), customerId: newId, type: 'credit', amount: opening, date: todayISO(), note: tr('opening_balance'), shot: false, seq: ++db.seq, createdAt: Date.now() });
        } else {
          const cc = custById(c.id); cc.name = name; cc.phone = phone; cc.dueDate = dueDate || '';
        }
      });
      if (!ok) return;
      closeSheet();
      toast(tr(isNew ? 'toast_customer_added' : 'toast_saved', { name }));
      if (isNew) go('#/c/' + encodeURIComponent(newId));
    });
  }

  function txnSheet(x) {
    const cur = Shots.mem.get(x.id);
    let newShot = null;
    const el = openSheet(
      '<h2 class="sheet-title">' + esc(tr('edit_entry')) + '</h2>' +
      '<form id="txn-form" novalidate autocomplete="off">' +
      '<div class="seg" role="radiogroup"><label class="seg-opt credit"><input type="radio" name="type" value="credit"' + (x.type === 'credit' ? ' checked' : '') + '><span>' + esc(tr('credit_given')) + '</span></label>' +
      '<label class="seg-opt payment"><input type="radio" name="type" value="payment"' + (x.type === 'payment' ? ' checked' : '') + '><span>' + esc(tr('payment_received')) + '</span></label></div>' +
      '<div class="grid2"><label class="field"><span>' + esc(tr('amount')) + ' (₹)</span><input name="amount" id="edit-amount" inputmode="decimal" value="' + plainAmt(x.amount) + '"></label>' +
      '<label class="field"><span>' + esc(tr('date')) + '</span><input type="date" name="date" id="edit-date" value="' + x.date + '"></label></div>' +
      '<label class="field"><span>' + esc(tr('note')) + '</span><input name="note" id="edit-note" maxlength="120" value="' + esc(x.note) + '"></label>' +
      '<div class="shot-field">' +
        (cur ? '<div class="shot-preview"><img id="edit-shot-preview" src="' + esc(cur) + '" alt=""><label class="check"><input type="checkbox" name="removeShot"> ' + esc(tr('remove_screenshot')) + '</label></div>' : '') +
        '<label class="shot-pick" for="edit-shot-input">' + ICON.camera + '<span>' + esc(cur ? tr('replace_screenshot') : tr('attach_screenshot')) + '</span></label>' +
        '<input type="file" id="edit-shot-input" accept="image/*" class="file-input">' +
        '<div class="shot-preview" id="edit-new-wrap" hidden><img id="edit-new-preview" alt=""></div>' +
      '</div>' +
      '<p class="form-error" role="alert" hidden></p>' +
      '<div class="btn-row"><button type="button" class="btn ghost" data-close>' + esc(tr('cancel')) + '</button><button type="submit" class="btn primary" id="txn-save">' + esc(tr('save_changes')) + '</button></div></form>');
    el.querySelector('#edit-shot-input').addEventListener('change', async (ev) => {
      const file = ev.target.files[0];
      try { newShot = await readImage(file); const w = el.querySelector('#edit-new-wrap'); w.hidden = !newShot; el.querySelector('#edit-new-preview').src = newShot || BLANK; }
      catch (e) { showFormError(el.querySelector('form'), e.message); ev.target.value = ''; }
    });
    el.querySelector('#txn-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const form = ev.target, f = form.elements;
      const amount = parseAmount(f.amount.value);
      if (!(amount > 0)) return showFormError(form, tr('err_amount'));
      if (!isValidISO(f.date.value)) return showFormError(form, tr('err_date'));
      let shot = x.shot;
      if (newShot) { try { await Shots.put(x.id, newShot); shot = true; } catch (e) { toast(tr('err_shot_save'), 'error'); } }
      else if (f.removeShot && f.removeShot.checked) { await Shots.del(x.id); shot = false; }
      const ok = commit(() => {
        const t = db.txns.find((y) => y.id === x.id);
        t.type = f.type.value === 'payment' ? 'payment' : 'credit';
        t.amount = amount; t.date = f.date.value; t.note = f.note.value.trim().slice(0, 120); t.shot = shot;
      });
      if (ok) { closeSheet(); toast(tr('toast_entry_updated')); }
    });
  }

  function statementRows(c) {
    const list = db.txns.filter((x) => x.customerId === c.id).sort(byOldest);
    let acc = 0;
    return list.map((x) => {
      acc += x.type === 'credit' ? toP(x.amount) : -toP(x.amount);
      return { x, bal: acc / 100 };
    });
  }
  function downloadStatement(c) {
    const S = computeStats().get(c.id);
    const rows = [
      ['Hisaab – ' + tr('statement')], [tr('shop_name'), db.shop.name || ''], [tr('customer'), c.name], [tr('mobile'), c.phone],
      [tr('generated_on'), todayISO()], [tr('total_credit'), S.creditP / 100], [tr('total_received'), S.paidP / 100], [tr('outstanding'), S.balP / 100], [],
      ['Date', 'Type', 'Note', 'Credit', 'Payment', 'Balance']
    ];
    for (const { x, bal } of statementRows(c)) rows.push([x.date, x.type, x.note, x.type === 'credit' ? x.amount : '', x.type === 'payment' ? x.amount : '', bal]);
    download('statement-' + fileSlug(c.name) + '-' + c.phone + '-' + todayISO() + '.csv', toCSV(rows), 'text/csv;charset=utf-8');
    toast(tr('toast_downloaded'));
  }
  function printStatement(c) {
    const S = computeStats().get(c.id);
    const rows = statementRows(c);
    $('#print-root').innerHTML =
      '<div class="ps"><h1>' + esc(db.shop.name || 'Hisaab') + '</h1><p>' + esc(tr('statement')) + ' · ' + fmtDate(todayISO()) + '</p>' +
      '<p><b>' + esc(c.name) + '</b> · +91 ' + c.phone + '</p>' +
      '<table><thead><tr><th>' + esc(tr('date')) + '</th><th>' + esc(tr('note')) + '</th><th>' + esc(tr('credit')) + '</th><th>' + esc(tr('payment')) + '</th><th>' + esc(tr('bal_short')) + '</th></tr></thead><tbody>' +
      rows.map(({ x, bal }) => '<tr><td>' + fmtDate(x.date) + '</td><td>' + esc(x.note) + '</td><td>' + (x.type === 'credit' ? fmtINR(x.amount) : '') + '</td><td>' + (x.type === 'payment' ? fmtINR(x.amount) : '') + '</td><td>' + fmtINR(bal) + '</td></tr>').join('') +
      '</tbody></table><p class="ps-total">' + esc(tr('total_credit')) + ': ' + fmtINR(S.creditP / 100) + ' · ' + esc(tr('total_received')) + ': ' + fmtINR(S.paidP / 100) + ' · <b>' + esc(tr('outstanding')) + ': ' + fmtINR(S.balP / 100) + '</b></p>' +
      '<p class="ps-foot">Generated with Hisaab</p></div>';
    window.print();
  }
  function exportLedgerCSV() {
    if (!db.txns.length) { toast(tr('no_txns'), 'error'); return; }
    const rows = [['Transaction ID', 'Date', 'Customer', 'Phone', 'Type', 'Amount', 'Note', 'Customer Balance After', 'Screenshot']];
    const run = new Map();
    for (const x of db.txns.slice().sort(byOldest)) {
      const c = custById(x.customerId);
      const b = (run.get(x.customerId) || 0) + (x.type === 'credit' ? toP(x.amount) : -toP(x.amount));
      run.set(x.customerId, b);
      rows.push([x.id, x.date, c.name, c.phone, x.type, x.amount, x.note, b / 100, x.shot ? 'yes' : 'no']);
    }
    download('hisaab-ledger-' + fileSlug(db.shop.name) + '-' + todayISO() + '.csv', toCSV(rows), 'text/csv;charset=utf-8');
    toast(tr('toast_downloaded'));
  }
  function exportBalancesCSV() {
    const S = computeStats();
    const rows = [['Name', 'Phone', 'Total Credit', 'Total Payments', 'Outstanding', 'Last Payment', 'Due Date']];
    for (const c of db.customers) { const s = S.get(c.id); rows.push([c.name, c.phone, s.creditP / 100, s.paidP / 100, s.balP / 100, s.lastPay || '', c.dueDate || '']); }
    const T = totals(S);
    rows.push([], ['Total outstanding', '', T.credit, T.paid, T.outstanding]);
    download('hisaab-balances-' + fileSlug(db.shop.name) + '-' + todayISO() + '.csv', toCSV(rows), 'text/csv;charset=utf-8');
    toast(tr('toast_downloaded'));
  }
  function backupJSON() {
    const shots = {};
    for (const x of db.txns) if (x.shot && Shots.mem.get(x.id)) shots[x.id] = Shots.mem.get(x.id);
    const data = {
      app: 'hisaab', version: 1, exportedAt: new Date().toISOString(), shop: db.shop.name, upiId: db.shop.upiId,
      customers: db.customers.map((c) => ({ id: c.id, name: c.name, phone: c.phone, createdAt: c.createdAt, dueDate: c.dueDate || undefined })),
      entries: db.txns.slice().sort(byOldest).map((x) => {
        const c = custById(x.customerId);
        return { id: x.id, phone: c.phone, type: x.type, amount: x.amount, date: x.date, note: x.note, shot: x.shot || undefined };
      }),
      shots
    };
    download('hisaab-backup-' + fileSlug(db.shop.name) + '-' + todayISO() + '.json', JSON.stringify(data, null, 1), 'application/json');
    toast(tr('toast_downloaded'));
  }

  // ---------- import ----------
  const CREDIT_WORDS = ['credit', 'udhar', 'udhaar', 'given', 'sale', 'debit', 'gave', 'diya'];
  const PAYMENT_WORDS = ['payment', 'paid', 'received', 'receipt', 'jama', 'got', 'mila', 'repayment'];
  function parseImport(text) {
    const errors = [], warnings = [];
    if (!String(text || '').trim()) return { error: tr('imp_empty') };
    let root;
    try { root = JSON.parse(text); } catch (e) {
      return { error: tr('imp_bad_json', { msg: String(e.message || e).replace(/^JSON\.parse:\s*/, '') }) };
    }
    if (Array.isArray(root)) root = { customers: root };
    if (!root || typeof root !== 'object') return { error: tr('imp_not_object') };
    const shopName = typeof root.shop === 'string' ? root.shop.trim()
      : (root.shop && typeof root.shop.name === 'string' ? root.shop.name.trim() : (typeof root.shopName === 'string' ? root.shopName.trim() : ''));
    const upiId = typeof root.upiId === 'string' ? root.upiId.trim() : (root.shop && typeof root.shop.upiId === 'string' ? root.shop.upiId.trim() : '');
    const rawCustomers = root.customers;
    if (!Array.isArray(rawCustomers)) return { error: tr('imp_no_customers') };
    let rawEntries = Array.isArray(root.entries) ? root.entries : Array.isArray(root.transactions) ? root.transactions : [];
    if (root.entries != null && !Array.isArray(root.entries)) return { error: tr('imp_entries_list') };
    const customers = [], byPhone = new Map();
    rawCustomers.forEach((c, i) => {
      if (!c || typeof c !== 'object') { errors.push(tr('imp_row_customer', { n: i + 1 }) + ': ' + tr('imp_not_object')); return; }
      const phone = normalizePhone(c.phone ?? c.mobile ?? c.number);
      const name = String(c.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
      if (!phone) { errors.push(tr('imp_row_customer', { n: i + 1 }) + ' (' + esc(name || '?') + '): ' + tr('imp_bad_phone', { v: esc(c.phone ?? '') })); return; }
      if (byPhone.has(phone)) { warnings.push(tr('imp_dup_phone', { phone })); }
      else {
        const rec = { id: uid(), name: name || ('Customer ' + phone.slice(-4)), phone, createdAt: isValidISO(c.createdAt) ? c.createdAt : '', dueDate: normalizeDate(c.dueDate) || '' };
        if (!name) warnings.push(tr('imp_no_name', { phone }));
        customers.push(rec); byPhone.set(phone, rec);
      }
      const nested = Array.isArray(c.entries) ? c.entries : Array.isArray(c.transactions) ? c.transactions : null;
      if (nested) rawEntries = rawEntries.concat(nested.map((e) => (e && typeof e === 'object' ? Object.assign({ phone }, e) : e)));
    });
    const txns = [];
    let seq = 0;
    rawEntries.forEach((e, i) => {
      const where = tr('imp_row_entry', { n: i + 1 });
      if (!e || typeof e !== 'object') { errors.push(where + ': ' + tr('imp_not_object')); return; }
      const phone = normalizePhone(e.phone ?? e.mobile);
      if (!phone) { errors.push(where + ': ' + tr('imp_bad_phone', { v: esc(e.phone ?? '') })); return; }
      const ty = String(e.type ?? '').trim().toLowerCase();
      const type = CREDIT_WORDS.includes(ty) ? 'credit' : PAYMENT_WORDS.includes(ty) ? 'payment' : null;
      if (!type) { errors.push(where + ': ' + tr('imp_bad_type', { v: esc(e.type ?? '') })); return; }
      const amount = typeof e.amount === 'number' ? (e.amount > 0 && e.amount <= 1e8 ? Math.round(e.amount * 100) / 100 : NaN) : parseAmount(e.amount);
      if (!(amount > 0)) { errors.push(where + ': ' + tr('imp_bad_amount', { v: esc(e.amount ?? '') })); return; }
      const date = normalizeDate(e.date);
      if (!date) { errors.push(where + ': ' + tr('imp_bad_date', { v: esc(e.date ?? '') })); return; }
      let cust = byPhone.get(phone);
      if (!cust) {
        cust = { id: uid(), name: String(e.name || '').trim() || ('Customer ' + phone.slice(-4)), phone, createdAt: '', dueDate: '' };
        customers.push(cust); byPhone.set(phone, cust);
        warnings.push(tr('imp_auto_customer', { phone }));
      }
      txns.push({ id: (typeof e.id === 'string' && e.id.length <= 80) ? e.id : uid(), phone, customerId: cust.id, type, amount, date,
        note: String(e.note ?? e.description ?? '').trim().replace(/\s+/g, ' ').slice(0, 120), shot: !!e.shot, seq: ++seq, createdAt: 0 });
    });
    // createdAt = earliest entry date when not provided
    for (const c of customers) {
      if (!c.createdAt) {
        const ds = txns.filter((x) => x.customerId === c.id).map((x) => x.date).sort();
        c.createdAt = ds[0] || todayISO();
      }
    }
    // ensure unique txn ids
    const seen = new Set();
    for (const x of txns) { if (seen.has(x.id)) x.id = uid(); seen.add(x.id); }
    if (!customers.length) return { error: tr('imp_nothing'), errors };
    const shots = root.shots && typeof root.shots === 'object' ? root.shots : {};
    return { shopName, upiId, customers, txns, errors, warnings, shots };
  }

  async function runImport(text, mode) {
    const box = $('#import-result');
    const res = parseImport(text);
    if (res.error) {
      importMsg = { kind: 'error', html: '<b>' + esc(tr('imp_failed')) + '</b> ' + esc(res.error) + (res.errors && res.errors.length ? '<ul>' + res.errors.slice(0, 8).map((e) => '<li>' + e + '</li>').join('') + '</ul>' : '') };
      if (box) { box.className = 'import-result error'; box.innerHTML = importMsg.html; box.hidden = false; }
      toast(tr('imp_failed'), 'error');
      return false;
    }
    if (mode === 'merge' && db.customers.length && db.shop.name && res.shopName && res.shopName.toLowerCase() !== db.shop.name.toLowerCase()) {
      importMsg = { kind: 'error', html: '<b>' + esc(tr('imp_failed')) + '</b> ' + esc(tr('imp_other_shop', { a: res.shopName, b: db.shop.name })) };
      if (box) { box.className = 'import-result error'; box.innerHTML = importMsg.html; box.hidden = false; }
      return false;
    }
    let added = 0, merged = 0, dupTx = 0;
    const replace = mode !== 'merge';
    if (replace && db.customers.length && !pushBackup('import')) {
      toast(tr('err_backup_space'), 'error', 6000);
    }
    const prevShots = replace ? Array.from(Shots.mem.keys()) : [];
    const ok = commit(() => {
      if (replace) {
        const fresh = emptyDb();
        fresh.shop.name = res.shopName || '';
        fresh.shop.upiId = res.upiId && UPI_RE.test(res.upiId) ? res.upiId : (db.shop.upiId && !res.shopName ? db.shop.upiId : '');
        if (!res.shopName && db.shop.upiId) fresh.shop.upiId = db.shop.upiId;
        for (const c of res.customers) fresh.customers.push({ id: c.id, name: c.name, phone: c.phone, createdAt: c.createdAt, dueDate: c.dueDate });
        for (const x of res.txns) fresh.txns.push({ id: x.id, customerId: x.customerId, type: x.type, amount: x.amount, date: x.date, note: x.note, shot: false, seq: ++fresh.seq, createdAt: 0 });
        added = fresh.customers.length;
        db = fresh;
      } else {
        if (!db.shop.name && res.shopName) db.shop.name = res.shopName;
        const idMap = new Map();
        for (const c of res.customers) {
          const ex = custByPhone(c.phone);
          if (ex) { idMap.set(c.id, ex.id); merged++; } else { db.customers.push({ id: c.id, name: c.name, phone: c.phone, createdAt: c.createdAt, dueDate: c.dueDate }); idMap.set(c.id, c.id); added++; }
        }
        const sig = (x) => [x.customerId, x.type, toP(x.amount), x.date, (x.note || '').toLowerCase()].join('|');
        const have = new Set(db.txns.map(sig));
        const ids = new Set(db.txns.map((x) => x.id));
        for (const x of res.txns) {
          const t = { id: ids.has(x.id) ? uid() : x.id, customerId: idMap.get(x.customerId), type: x.type, amount: x.amount, date: x.date, note: x.note, shot: false, seq: ++db.seq, createdAt: 0 };
          if (have.has(sig(t))) { dupTx++; continue; }
          db.txns.push(t); ids.add(t.id);
        }
      }
    });
    if (!ok) return false;
    if (replace) { for (const id of prevShots) await Shots.del(id); }
    // restore screenshots carried in a Hisaab backup file
    const shotIds = Object.keys(res.shots || {});
    if (shotIds.length) {
      let restored = 0;
      for (const x of db.txns) {
        const u = res.shots[x.id];
        if (typeof u === 'string' && /^data:image\//.test(u)) { try { await Shots.put(x.id, u); x.shot = true; restored++; } catch (e) { /* skip */ } }
      }
      if (restored) persist();
    }
    const S = computeStats();
    const T = totals(S);
    let html = '<b>' + esc(tr('imp_done')) + '</b> ' + esc(tr(replace ? 'imp_summary_replace' : 'imp_summary_merge', {
      shop: res.shopName || tr('my_shop'), c: res.customers.length, e: res.txns.length - dupTx, added, merged
    })) + ' ' + esc(tr('total_outstanding')) + ': <b>' + fmtINR(T.outstanding) + '</b>.';
    if (dupTx) html += '<br>' + esc(tr('imp_dups_skipped', { n: dupTx }));
    if (replace && getBackups().length) html += '<br><small>' + esc(tr('imp_backup_note')) + '</small>';
    const notes = res.errors.concat(res.warnings);
    if (notes.length) html += '<details><summary>' + esc(tr('imp_notes', { n: notes.length })) + '</summary><ul>' + notes.slice(0, 50).map((e) => '<li>' + e + '</li>').join('') + '</ul></details>';
    importMsg = { kind: res.errors.length ? 'warn' : 'ok', html };
    searchQuery = '';
    lastQuickCustomer = '';
    render();
    toast(tr('imp_done'));
    return true;
  }

  // ---------- events ----------
  document.addEventListener('click', async (ev) => {
    if (ev.target.closest('[data-close]')) { closeSheet(); return; }
    const a = ev.target.closest('[data-action]');
    if (!a) return;
    const act = a.dataset.action;
    const id = a.dataset.id;
    switch (act) {
      case 'add-customer': ev.preventDefault(); customerSheet(null); break;
      case 'edit-customer': customerSheet(custById(id)); break;
      case 'delete-customer': {
        const c = custById(id);
        const n = db.txns.filter((x) => x.customerId === id).length;
        if (!(await confirmDialog({ title: tr('delete_customer_q', { name: c.name }), message: tr('delete_customer_msg', { n }), ok: tr('delete') }))) return;
        const shotIds = db.txns.filter((x) => x.customerId === id && x.shot).map((x) => x.id);
        if (commit(() => { db.customers = db.customers.filter((x) => x.id !== id); db.txns = db.txns.filter((x) => x.customerId !== id); })) {
          shotIds.forEach((s) => Shots.del(s));
          toast(tr('toast_deleted'));
          go('#/');
        }
        break;
      }
      case 'edit-txn': { const x = db.txns.find((y) => y.id === id); if (x) txnSheet(x); break; }
      case 'delete-txn': {
        const x = db.txns.find((y) => y.id === id);
        if (!x) return;
        if (!(await confirmDialog({ title: tr('delete_entry_q'), message: tr('delete_entry_msg', { amount: fmtINR(x.amount), date: fmtDate(x.date) }), ok: tr('delete') }))) return;
        if (commit(() => { db.txns = db.txns.filter((y) => y.id !== id); })) { if (x.shot) Shots.del(id); toast(tr('toast_deleted')); }
        break;
      }
      case 'focus-entry': {
        const form = $('#entry-form');
        const r = form.querySelector('input[name=type][value="' + a.dataset.type + '"]');
        if (r) r.checked = true;
        $('#entry-heading').textContent = tr(a.dataset.type === 'payment' ? 'add_payment' : 'add_credit');
        $('#entry-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => $('#entry-amount').focus({ preventScroll: true }), 250);
        break;
      }
      case 'clear-shot': {
        pendingShot = null;
        const inp = $('#shot-input'); if (inp) inp.value = '';
        $('#shot-preview-wrap').hidden = true;
        break;
      }
      case 'view-shot': {
        const u = Shots.mem.get(id);
        if (u) openSheet('<h2 class="sheet-title">' + esc(tr('payment_screenshot')) + '</h2><img class="shot-full" src="' + esc(u) + '" alt=""><div class="btn-row"><button type="button" class="btn ghost" data-close>' + esc(tr('close')) + '</button></div>', { center: true });
        break;
      }
      case 'statement': downloadStatement(custById(id)); break;
      case 'print-statement': printStatement(custById(id)); break;
      case 'export-csv': exportLedgerCSV(); break;
      case 'export-balances': exportBalancesCSV(); break;
      case 'backup': backupJSON(); break;
      case 'goto-import': ev.preventDefault(); $('#import-section').scrollIntoView({ behavior: 'smooth' }); setTimeout(() => $('#import-box').focus({ preventScroll: true }), 300); break;
      case 'restore-backup': {
        const b = getBackups()[Number(a.dataset.i)];
        if (!b) return;
        if (!(await confirmDialog({ title: tr('restore_q'), message: tr('restore_msg', { shop: b.shop || tr('my_shop') }), ok: tr('restore'), danger: false }))) return;
        pushBackup('restore');
        if (commit(() => { db = sanitizeDb(b.data); })) toast(tr('toast_restored'));
        break;
      }
      case 'clear-all': {
        if (!(await confirmDialog({ title: tr('clear_all_q'), message: tr('clear_all_msg'), ok: tr('clear_all') }))) return;
        pushBackup('clear');
        if (commit(() => { db = emptyDb(); })) { await Shots.clear(); importMsg = null; toast(tr('toast_cleared')); }
        break;
      }
      default: break;
    }
  });

  document.addEventListener('click', (ev) => {
    if (ev.target.id === 'import-go' || ev.target.closest('#import-go')) {
      ev.preventDefault();
      const box = $('#import-box');
      runImport(box ? box.value : '', ($('#import-mode') || {}).value || 'replace');
    }
  });

  document.addEventListener('submit', (ev) => {
    const form = ev.target;
    if (form.id === 'entry-form') { ev.preventDefault(); submitEntry(form); }
    else if (form.id === 'shop-form') {
      ev.preventDefault();
      const name = form.elements.shopName.value.trim().replace(/\s+/g, ' ').slice(0, 80);
      const upi = form.elements.upiId.value.trim();
      if (upi && !UPI_RE.test(upi)) return showFormError(form, tr('err_upi'));
      showFormError(form, '');
      if (commit(() => { db.shop.name = name; db.shop.upiId = upi; })) toast(tr('toast_saved', { name: name || tr('my_shop') }));
    }
  });

  document.addEventListener('input', (ev) => {
    if (ev.target.id === 'search') { searchQuery = ev.target.value; applySearch(); }
    if (ev.target.closest && ev.target.closest('.form-error') == null) {
      const form = ev.target.form;
      const err = form && form.querySelector('.form-error');
      if (err && !err.hidden) err.hidden = true;
    }
  });

  document.addEventListener('change', async (ev) => {
    const t = ev.target;
    if (t.id === 'shot-input') {
      const file = t.files && t.files[0];
      const wrap = $('#shot-preview-wrap');
      if (!file) { pendingShot = null; wrap.hidden = true; return; }
      try {
        pendingShot = await readImage(file);
        $('#shot-preview').src = pendingShot;
        wrap.hidden = false;
      } catch (e) {
        pendingShot = null; t.value = ''; wrap.hidden = true;
        showFormError(t.form, e.message);
      }
    } else if (t.id === 'import-file') {
      const file = t.files && t.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const box = $('#import-box'); if (box) box.value = text;
        await runImport(text, ($('#import-mode') || {}).value || 'replace');
      } catch (e) { toast(tr('imp_failed'), 'error'); }
      t.value = '';
    } else if (t.id === 'restore-file') {
      const file = t.files && t.files[0];
      if (!file) return;
      const text = await file.text();
      t.value = '';
      if (!(await confirmDialog({ title: tr('restore_q'), message: tr('restore_file_msg'), ok: tr('restore'), danger: false }))) return;
      if (location.hash !== '#/') { location.hash = '#/'; }
      setTimeout(() => runImport(text, 'replace'), 30);
    } else if (t.id === 'lang-select' || t.id === 'settings-lang') {
      prefs.lang = t.value; savePrefs(); render();
    } else if (t.name === 'theme' && t.closest('#view')) {
      setTheme(t.value);
    } else if (t.name === 'type' && t.form && t.form.id === 'entry-form') {
      const hd = $('#entry-heading'); if (hd) hd.textContent = tr(t.value === 'payment' ? 'add_payment' : 'add_credit');
    }
  });

  function setTheme(th) {
    prefs.theme = th; savePrefs();
    document.documentElement.setAttribute('data-theme', th);
    applyChrome();
    const meta = $('meta[name=theme-color]'); if (meta) meta.content = th === 'dark' ? '#0B1411' : '#0B7A47';
  }
  $('#theme-toggle').addEventListener('click', () => { setTheme(curTheme() === 'dark' ? 'light' : 'dark'); if (route().name === 'settings') render(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeSheet(); });
  window.addEventListener('hashchange', () => { closeSheet(); const r = route(); if (r.name !== 'home') importMsg = null; render(); if (r.focus !== 'import') window.scrollTo(0, 0); });
  // Another tab changed the ledger – reload instead of overwriting it later.
  window.addEventListener('storage', (ev) => {
    if (ev.key === KEY) { db = loadDb(); render(); toast(tr('toast_synced')); }
    if (ev.key === PKEY) { prefs = loadPrefs(); render(); }
  });

  // ---------- boot ----------
  if (prefs.theme) document.documentElement.setAttribute('data-theme', prefs.theme);
  render();
  if (!storageOk) toast(tr('err_storage_off'), 'error', 8000);
  Shots.loadAll().then(() => hydrateShots());

  // Small read-only hook for debugging/tests (no secrets, no mutation).
  window.Hisaab = Object.freeze({
    version: '1.0.0',
    today: todayISO,
    balances() { const S = computeStats(); const o = {}; for (const c of db.customers) o[c.phone] = S.get(c.id).balP / 100; return o; },
    totalOutstanding() { return totals(computeStats()).outstanding; }
  });
})();
