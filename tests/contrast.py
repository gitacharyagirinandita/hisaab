"""Measured readability audit: WCAG contrast of every visible text element, light + dark, every view.
python3 tests/contrast.py [BASE_URL]"""
import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765').rstrip('/')
SAMPLE = (ROOT / 'samples' / 'sample-data.json').read_text()

JS = r'''() => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const blend = (top, bot) => [0, 1, 2].map(i => top[i] * top[3] + bot[i] * (1 - top[3])).concat(1);
  function bgOf(el) {
    const stack = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none' && /gradient/.test(cs.backgroundImage)) {
        const cols = [...cs.backgroundImage.matchAll(/rgba?\([^)]+\)/g)].map(m => parse(m[0]));
        // worst case = lightest stop for light text
        stack.push({ grad: cols }); break;
      }
      const c = parse(cs.backgroundColor); if (c && c[3] > 0) { stack.push(c); if (c[3] >= 1) break; }
    }
    return stack;
  }
  function opacityOf(el) { let o = 1; for (let e = el; e; e = e.parentElement) o *= +getComputedStyle(e).opacity; return o; }
  const out = [];
  const els = [...document.querySelectorAll('body *')].filter(e => {
    if (e.closest('svg') || ['SCRIPT', 'STYLE', 'OPTION'].includes(e.tagName) || ['radio', 'checkbox', 'file', 'hidden'].includes(e.type)) return false;
    const own = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) || (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName) && (e.value || e.placeholder));
    if (!own) return false;
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !e.closest('[hidden]') && !e.closest('.sr-only') && !e.closest('.print-root') && !e.closest('.skip-link');
  });
  for (const e of els) {
    const cs = getComputedStyle(e);
    let fg = parse(cs.color); if (!fg) continue;
    const st = bgOf(e);
    let bg = [255, 255, 255, 1];
    const pageBg = parse(getComputedStyle(document.body).backgroundColor);
    let ratios = [];
    const resolve = (base) => { let b = base; for (let i = st.length - 1; i >= 0; i--) { const s = st[i]; if (s.grad) continue; b = blend(s, b); } return b; };
    const g = st.find(s => s.grad);
    const bases = g ? g.grad.map(c => blend(c, pageBg)) : [pageBg];
    for (const base of bases) {
      const b = resolve(base);
      const op = opacityOf(e);
      const f = blend([fg[0], fg[1], fg[2], fg[3] * op], b);
      const L1 = lum(f), L2 = lum(b);
      ratios.push((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05));
    }
    const ratio = Math.min(...ratios);
    const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const isPh = ['INPUT', 'TEXTAREA'].includes(e.tagName) && !e.value;
    const need = large ? 3 : 4.5;
    const text = (isPh ? '[placeholder] ' + e.placeholder : (e.value || [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(''))).trim().slice(0, 40);
    out.push({ text, cls: (e.className && e.className.baseVal == null ? e.className : '') || e.tagName, ratio: Math.round(ratio * 100) / 100, need, ph: isPh });
  }
  return out;
}'''

PH_JS = '''(t) => { const s = document.createElement('style'); s.id='phc'; document.head.appendChild(s); }'''

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get('CHROME', '/usr/bin/google-chrome'), args=['--no-sandbox'])
    report = {}
    for theme in ['light', 'dark']:
        ctx = b.new_context(viewport={'width': 375, 'height': 812}, color_scheme=theme)
        page = ctx.new_page()
        page.goto(BASE + '/?today=2026-11-15'); page.wait_for_selector('#import-box')
        page.fill('#import-box', SAMPLE); page.click('#import-go'); page.wait_for_timeout(300)
        views = {}
        def grab(name):
            views[name] = page.evaluate(JS)
        grab('home')
        page.click('[data-customer="9000000102"] .cust-main'); page.wait_for_selector('#txn-list'); grab('account')
        page.goto(BASE + '/?today=2026-11-15#/settings'); page.wait_for_timeout(200); grab('settings')
        page.goto(BASE + '/?today=2026-11-15#/guide'); page.wait_for_timeout(200); grab('guide')
        page.goto(BASE + '/?today=2026-11-15&tour=1#/'); page.wait_for_selector('#tour-root'); page.wait_for_timeout(400); grab('tour-lang')
        page.click('[data-tour-lang="en"]'); page.wait_for_timeout(900)
        t = page.evaluate(JS); views['tour-step'] = [x for x in t if 'tour' in str(x['cls']) or x['text'] in ('Next', 'Skip tour')]
        report[theme] = views
        ctx.close()
    b.close()

fails = []
summary = {}
for theme, views in report.items():
    allr = [x for v in views.values() for x in v]
    summary[theme] = {'elements': len(allr), 'min': min(x['ratio'] for x in allr)}
    for vname, items in views.items():
        for x in items:
            if x['ratio'] < x['need']:
                fails.append((theme, vname, x['text'], x['cls'], x['ratio'], x['need']))
seen = set(); uniq = []
for f in fails:
    k = (f[0], f[2], f[3])
    if k not in seen: seen.add(k); uniq.append(f)
print(json.dumps(summary))
for f in uniq: print('LOW', f)
print('total low-contrast items:', len(uniq))
(ROOT / 'tests' / 'contrast-report.json').write_text(json.dumps({'summary': summary, 'low': uniq}, indent=1, ensure_ascii=False))
