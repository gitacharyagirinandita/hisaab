"""Hisaab acceptance tests (Playwright, headless Chrome).

Usage:  python3 tests/acceptance.py [BASE_URL]
Default BASE_URL is http://127.0.0.1:8765 (serve the repo root with `python3 -m http.server 8765`).
Writes a JSON report to tests/report.json and prints a summary.
"""
import json, os, re, sys, base64, urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765').rstrip('/')
SAMPLE = (ROOT / 'samples' / 'sample-data.json').read_text()
EXPECTED = json.loads((ROOT / 'samples' / 'sample-expected.json').read_text())
CHROME = os.environ.get('CHROME', '/usr/bin/google-chrome')
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGNgYPj/n4GBgYGJAQoAAP//AwB+BwH/s9pTAAAAAElFTkSuQmCC')

results = []
def check(name, cond, detail=''):
    results.append({'test': name, 'pass': bool(cond), 'detail': detail})
    print(('PASS ' if cond else 'FAIL ') + name + ((' — ' + str(detail)) if detail else ''))

def num(s):
    s = re.sub(r'[^\d.\-]', '', s or '')
    return float(s) if s not in ('', '-', '.') else None

OTHER_SHOP = {
    "shop": "Sri Sai Stationery (test)",
    "customers": [
        {"name": "Arjun Mehta", "phone": "+91 98765 43210"},
        {"name": "Divya <b>Shah</b>", "phone": "8123456789"},
        {"name": "Zero Balance", "phone": "7000000001"}
    ],
    "entries": [
        {"phone": "9876543210", "type": "credit", "amount": 499.5, "date": "2026-11-01", "note": "notebooks"},
        {"phone": "9876543210", "type": "payment", "amount": "200", "date": "2026-11-10", "note": "cash"},
        {"phone": "8123456789", "type": "credit", "amount": 1200, "date": "2026-10-01", "note": "<img src=x onerror=alert(1)>"},
        {"phone": "7000000001", "type": "credit", "amount": 300, "date": "2026-11-02", "note": "pens"},
        {"phone": "7000000001", "type": "payment", "amount": 300, "date": "2026-11-05", "note": "paid"},
        {"phone": "8123456789", "type": "credit", "amount": -5, "date": "2026-11-01", "note": "bad"},
        {"phone": "8123456789", "type": "credit", "amount": 0, "date": "2026-11-01", "note": "zero"}
    ]
}

def do_import(page, text):
    page.fill('#import-box', text)
    page.click('#import-go')
    page.wait_for_timeout(250)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
    ctx = browser.new_context(viewport={'width': 375, 'height': 812}, device_scale_factor=2, accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d: (errors.append('native dialog: ' + d.message), d.dismiss()))

    page.goto(BASE + '/?today=2026-11-15')
    page.wait_for_selector('#import-box')
    check('05 import textarea #import-box exists', page.locator('textarea#import-box').count() == 1)
    check('06 import button #import-go exists', page.locator('button#import-go').count() == 1)
    check('07 payment screenshot input#shot-input[type=file] exists', page.locator('input[type=file]#shot-input').count() == 1)

    # --- Import official sample ---
    do_import(page, SAMPLE)
    total = num(page.inner_text('#total-outstanding'))
    check('01 total outstanding = %s' % EXPECTED['total_outstanding'], total == EXPECTED['total_outstanding'], page.inner_text('#total-outstanding'))
    phones = page.eval_on_selector_all('[data-customer]', 'els => els.map(e => e.getAttribute("data-customer"))')
    check('02 one customer row per phone', sorted(phones) == sorted(EXPECTED['balances'].keys()) and len(phones) == len(set(phones)), phones)
    mism = {}
    for ph, exp in EXPECTED['balances'].items():
        got = num(page.inner_text('[data-customer="%s"] [data-balance]' % ph))
        if got != exp: mism[ph] = (got, exp)
    check('03 every customer balance matches sample-expected.json', not mism, mism or 'all 8 match')
    pos = sum(v for v in EXPECTED['balances'].values() if v > 0)
    check('01b total equals sum of positive balances', total == pos)
    with_bal = page.eval_on_selector_all('[data-customer] [data-balance]', 'els => els.filter(e => parseFloat(e.dataset.balance) > 0).length')
    check('01c customers_with_balance = %d' % EXPECTED['customers_with_balance'], with_bal == EXPECTED['customers_with_balance'])
    first = page.eval_on_selector('#customer-list .cust-row', 'e => e.dataset.customer')
    check('01d top defaulter listed first (%s)' % EXPECTED['top_defaulter_phone'], first == EXPECTED['top_defaulter_phone'], first)

    # --- WhatsApp ---
    wa_ok, wa_bad = 0, []
    for ph, exp in EXPECTED['balances'].items():
        a = page.locator('a[data-remind="%s"]' % ph)
        if a.count() != 1: wa_bad.append((ph, 'count', a.count())); continue
        href = a.get_attribute('href')
        m = re.match(r'^https://wa\.me/91(\d{10})\?text=(.+)$', href or '')
        if not m or m.group(1) != ph: wa_bad.append((ph, href)); continue
        text = urllib.parse.unquote(m.group(2))
        name = page.inner_text('[data-customer="%s"] .cust-name' % ph)
        if ('Rs %d' % exp) not in text or name not in text or 'Kindly' not in text: wa_bad.append((ph, text)); continue
        wa_ok += 1
    check('04 WhatsApp a[data-remind] → wa.me/91<phone>?text= with name + balance', wa_ok == 8 and not wa_bad, wa_bad or 'all 8 ok')
    sample_href = page.get_attribute('a[data-remind="9000000102"]', 'href')
    check('04b reminder opens in new tab, not auto-sent', page.get_attribute('a[data-remind="9000000102"]', 'target') == '_blank')

    # --- Search ---
    page.fill('#search', 'sunita')
    vis = page.eval_on_selector_all('[data-customer]', 'els => els.filter(e => !e.hidden).map(e => e.dataset.customer)')
    page.fill('#search', '0105')
    vis2 = page.eval_on_selector_all('[data-customer]', 'els => els.filter(e => !e.hidden).map(e => e.dataset.customer)')
    page.fill('#search', 'zzzz')
    vis3 = page.eval_on_selector_all('[data-customer]', 'els => els.filter(e => !e.hidden).length')
    page.fill('#search', '')
    check('13 search by name and phone', vis == ['9000000102'] and vis2 == ['9000000105'] and vis3 == 0, (vis, vis2, vis3))

    # --- Overdue ---
    od = page.eval_on_selector_all('[data-overdue]', 'els => els.map(e => [e.dataset.overdue, +e.dataset.days])')
    days = [d for _, d in od]
    check('16 overdue list sorted by days since last payment (desc)', len(od) == 8 and days == sorted(days, reverse=True), od)
    # independent computation: days since last payment relative to ?today
    import datetime as dt
    entries = json.loads(SAMPLE)['entries']
    lastpay = {}
    for e in entries:
        if e['type'] == 'payment': lastpay[e['phone']] = max(lastpay.get(e['phone'], ''), e['date'])
    expdays = {ph: (dt.date(2026, 11, 15) - dt.date.fromisoformat(d)).days for ph, d in lastpay.items()}
    check('16b overdue day counts correct vs ?today=2026-11-15', all(expdays[ph] == d for ph, d in od), expdays)

    # --- Date parameter ---
    check('10 ?today sets default entry date', page.input_value('#entry-date') == '2026-11-15', page.input_value('#entry-date'))

    # --- Customer page / ordering ---
    page.click('[data-customer="9000000101"] .cust-main')
    page.wait_for_selector('#txn-list')
    dates = page.eval_on_selector_all('#txn-list .txn', 'els => els.map(e => e.dataset.date)')
    check('09 customer history newest first', dates == sorted(dates, reverse=True) and len(dates) == 6, dates)
    check('05b account page shows balance', num(page.inner_text('#account-balance')) == 670)
    check('10b account page entry date uses ?today', page.input_value('#entry-date') == '2026-11-15')

    # --- Add payment with screenshot ---
    page.click('#btn-add-payment')
    page.set_input_files('#shot-input', files=[{'name': 'upi.png', 'mimeType': 'image/png', 'buffer': PNG}])
    page.wait_for_selector('#shot-preview-wrap:not([hidden])', timeout=3000)
    prev_ok = page.eval_on_selector('#shot-preview', 'i => i.src.startsWith("data:image")')
    page.fill('#entry-amount', '170')
    page.fill('#entry-note', 'UPI part payment')
    page.click('#entry-save')
    page.wait_for_selector('img[data-shot]', timeout=3000)
    shot = page.eval_on_selector('img[data-shot]', 'i => ({src: i.src.slice(0, 22), w: i.naturalWidth})')
    check('08 saved payment shows img[data-shot] thumbnail (preview before save: %s)' % prev_ok, prev_ok and shot['src'].startswith('data:image') and shot['w'] > 0, shot)
    check('06b balance recalculated after payment (670-170=500)', num(page.inner_text('#account-balance')) == 500)
    top = page.eval_on_selector('#txn-list .txn', 'e => [e.dataset.date, e.dataset.type, e.dataset.amount]')
    check('09b new entry on 2026-11-15 shows first', top == ['2026-11-15', 'payment', '170'], top)

    # zero / negative amounts rejected
    page.click('#btn-add-credit')
    page.fill('#entry-amount', '0'); page.click('#entry-save'); page.wait_for_timeout(150)
    err0 = page.is_visible('#entry-form .form-error')
    page.fill('#entry-amount', '-50'); page.click('#entry-save'); page.wait_for_timeout(150)
    errn = page.is_visible('#entry-form .form-error')
    cnt = page.locator('#txn-list .txn').count()
    check('06c zero and negative amounts rejected', err0 and errn and cnt == 7, (err0, errn, cnt))

    # --- Refresh persistence (incl. screenshot from IndexedDB) ---
    page.reload()
    page.wait_for_selector('#txn-list')
    page.wait_for_function('() => { const i = document.querySelector("img[data-shot]"); return i && i.src.startsWith("data:image") }', timeout=4000)
    check('11 data + screenshot survive refresh', num(page.inner_text('#account-balance')) == 500 and page.locator('img[data-shot]').count() == 1)

    # --- Edit & delete transaction ---
    first_id = page.eval_on_selector('#txn-list .txn', 'e => e.dataset.txn')
    page.click('[data-action="edit-txn"][data-id="%s"]' % first_id)
    page.fill('#edit-amount', '270')
    page.click('#txn-save')
    page.wait_for_timeout(250)
    after_edit = num(page.inner_text('#account-balance'))
    page.click('[data-action="delete-txn"][data-id="%s"]' % first_id)
    page.click('#confirm-ok')
    page.wait_for_timeout(250)
    after_del = num(page.inner_text('#account-balance'))
    check('14 edit (balance 400) and delete (balance 670) recalculate', after_edit == 400 and after_del == 670, (after_edit, after_del))
    page.goto(BASE + '/?today=2026-11-15#/')
    page.wait_for_selector('#total-outstanding')
    check('14b dashboard total back to 11820 after edit+delete', num(page.inner_text('#total-outstanding')) == 11820)

    # --- CSV export ---
    with page.expect_download() as d:
        page.click('#export-csv')
    csv_text = Path(d.value.path()).read_text(encoding='utf-8-sig')
    rows = [r.split(',') for r in csv_text.strip().splitlines()[1:]]
    bal = {}
    for r in rows:
        bal[r[3]] = bal.get(r[3], 0) + (float(r[5]) if r[4] == 'credit' else -float(r[5]))
    check('15 CSV export rows match ledger (38 entries, balances match)', len(rows) == 38 and all(abs(bal[k] - v) < 1e-9 for k, v in EXPECTED['balances'].items()), len(rows))

    # --- UPI ---
    page.goto(BASE + '/?today=2026-11-15#/settings')
    page.fill('#upi-id', 'not a upi')
    page.click('#shop-save'); page.wait_for_timeout(150)
    upi_rej = page.is_visible('#shop-form .form-error')
    page.fill('#upi-id', 'lakshmistore@okaxis')
    page.click('#shop-save'); page.wait_for_timeout(150)
    page.goto(BASE + '/?today=2026-11-15#/')
    page.wait_for_selector('a[data-remind]')
    t = urllib.parse.unquote(page.get_attribute('a[data-remind="9000000102"]', 'href'))
    check('19 UPI link in reminder when configured (invalid UPI rejected)', upi_rej and 'upi://pay?pa=lakshmistore@okaxis' in t and 'am=3470.00' in t, t[-160:])
    check('19b no UPI link before configured', 'upi://' not in urllib.parse.unquote(sample_href))

    # --- Hindi / Telugu ---
    page.select_option('#lang-select', 'hi')
    hi = page.inner_text('#overdue-section h2') + ' | ' + page.inner_text('.hero-label')
    hi_total = num(page.inner_text('#total-outstanding'))
    page.select_option('#lang-select', 'te')
    te = page.inner_text('.hero-label')
    page.select_option('#lang-select', 'kn')
    kn = page.inner_text('.hero-label')
    page.reload(); page.wait_for_selector('.hero-label')
    kn_persist = page.inner_text('.hero-label') == kn
    page.select_option('#lang-select', 'en')
    check('20 Hindi / Telugu / Kannada labels (numbers unchanged, persisted)', 'कुल बकाया' in hi and 'మొత్తం బాకీ' in te and 'ಒಟ್ಟು ಬಾಕಿ' in kn and hi_total == 11820 and kn_persist, (hi, te, kn))

    # --- Dark mode ---
    bg_light = page.evaluate('getComputedStyle(document.body).backgroundColor')
    page.click('#theme-toggle')
    bg_dark = page.evaluate('getComputedStyle(document.body).backgroundColor')
    theme = page.evaluate('document.documentElement.dataset.theme')
    page.reload(); page.wait_for_selector('#total-outstanding')
    theme2 = page.evaluate('document.documentElement.dataset.theme')
    page.screenshot(path=str(ROOT / 'tests' / 'screens' / 'dashboard-dark-375.png'), full_page=True)
    page.click('#theme-toggle')
    check('18 light/dark modes switch and persist', bg_light != bg_dark and theme == 'dark' and theme2 == 'dark', (bg_light, bg_dark))

    # --- 375px no horizontal scroll on all views ---
    overflow = {}
    for h in ['#/', '#/settings']:
        page.goto(BASE + '/?today=2026-11-15' + h); page.wait_for_timeout(200)
        overflow[h] = page.evaluate('document.documentElement.scrollWidth')
    page.goto(BASE + '/?today=2026-11-15#/'); page.wait_for_selector('[data-customer]')
    page.screenshot(path=str(ROOT / 'tests' / 'screens' / 'dashboard-375.png'), full_page=True)
    page.click('[data-customer="9000000102"] .cust-main'); page.wait_for_selector('#txn-list')
    overflow['account'] = page.evaluate('document.documentElement.scrollWidth')
    page.screenshot(path=str(ROOT / 'tests' / 'screens' / 'account-375.png'), full_page=True)
    page.click('[data-action="add-customer"] >> nth=0'); page.wait_for_selector('#customer-form')
    overflow['add-sheet'] = page.evaluate('document.documentElement.scrollWidth')
    page.screenshot(path=str(ROOT / 'tests' / 'screens' / 'add-customer-375.png'))
    page.keyboard.press('Escape')
    check('17 no horizontal scroll at 375px (all views)', all(v <= 375 for v in overflow.values()), overflow)

    # --- Add customer validation: duplicate phone, invalid phone ---
    page.goto(BASE + '/?today=2026-11-15#/'); page.wait_for_selector('#add-customer-btn')
    page.click('#add-customer-btn'); page.fill('#cust-name', 'Duplicate Ravi'); page.fill('#cust-phone', '9000000101'); page.click('#cust-save'); page.wait_for_timeout(150)
    dup_err = page.is_visible('#customer-form .form-error')
    page.fill('#cust-phone', '12345'); page.click('#cust-save'); page.wait_for_timeout(150)
    bad_err = page.is_visible('#customer-form .form-error')
    page.fill('#cust-name', 'Naveen Gupta'); page.fill('#cust-phone', '9988776655'); page.fill('#cust-opening', '250'); page.click('#cust-save')
    page.wait_for_selector('#account-balance')
    new_bal = num(page.inner_text('#account-balance'))
    page.goto(BASE + '/?today=2026-11-15#/'); page.wait_for_selector('#total-outstanding')
    check('C1 add customer: duplicate + invalid phone rejected, opening balance works', dup_err and bad_err and new_bal == 250 and num(page.inner_text('#total-outstanding')) == 12070)

    # --- Malformed JSON ---
    do_import(page, '{"customers": [ {"name": "x", ')
    bad_json = page.inner_text('#import-result')
    still = num(page.inner_text('#total-outstanding'))
    do_import(page, '{"shop": "x"}')
    no_cust = page.inner_text('#import-result')
    check('12a malformed JSON → clear error, data untouched', 'not valid JSON' in bad_json and 'customers' in no_cust and still == 12070, (bad_json[:80], no_cust[:80]))

    # --- Different shop data (replace) + XSS escaping ---
    do_import(page, json.dumps(OTHER_SHOP))
    phones2 = page.eval_on_selector_all('[data-customer]', 'els => els.map(e => e.dataset.customer)')
    tot2 = num(page.inner_text('#total-outstanding'))
    b = {ph: num(page.inner_text('[data-customer="%s"] [data-balance]' % ph)) for ph in phones2}
    xss = page.evaluate('document.querySelectorAll("#view b img, #view img[src=x]").length') == 0 and 'Divya <b>Shah</b>' in page.inner_text('#customer-list')
    res_txt = page.inner_text('#import-result')
    zero_href = urllib.parse.unquote(page.get_attribute('a[data-remind="7000000001"]', 'href'))
    check('12 different shop JSON replaces old shop (no silent merge), skips invalid rows',
          sorted(phones2) == ['7000000001', '8123456789', '9876543210'] and tot2 == 1499.5 and b == {'9876543210': 299.5, '8123456789': 1200, '7000000001': 0},
          (tot2, b, res_txt[:160]))
    check('12b user text escaped (no HTML injection)', xss)
    check('04c zero-balance customer gets no payment-due reminder', 'outstanding balance' not in zero_href and 'settled' in zero_href, zero_href[:120])

    # merge from a different shop is refused
    page.select_option('#import-mode', 'merge')
    do_import(page, SAMPLE)
    refused = 'belongs to' in page.inner_text('#import-result') and num(page.inner_text('#total-outstanding')) == 1499.5
    check('12c merge of unrelated shop data refused with message', refused)
    page.select_option('#import-mode', 'replace')
    do_import(page, SAMPLE)
    check('12d re-import sample → 11820 again; previous shop kept as auto-backup',
          num(page.inner_text('#total-outstanding')) == 11820 and page.evaluate('JSON.parse(localStorage.getItem("hisaab:backups:v1")).length') >= 1)

    # --- Close and reopen (new page, same context = same browser profile) ---
    page2 = ctx.new_page(); page2.goto(BASE + '/'); page2.wait_for_selector('#total-outstanding')
    check('11b data survives closing and reopening the tab', num(page2.inner_text('#total-outstanding')) == 11820)

    # --- No ?today → local date ---
    today_local = page2.evaluate('(() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0") })()')
    check('10c without ?today the entry date is the local date', page2.input_value('#entry-date') == today_local, today_local)
    page2.close()

    # --- Timezone robustness: run in a UTC-10 and UTC+14 browser ---
    for tz in ['Pacific/Honolulu', 'Pacific/Kiritimati']:
        c3 = browser.new_context(timezone_id=tz, viewport={'width': 375, 'height': 812})
        p3 = c3.new_page(); p3.goto(BASE + '/?today=2026-11-15'); p3.wait_for_selector('#import-box')
        p3.fill('#import-box', SAMPLE); p3.click('#import-go'); p3.wait_for_timeout(250)
        od3 = p3.eval_on_selector_all('[data-overdue]', 'els => els.map(e => [e.dataset.overdue, +e.dataset.days])')
        ok = p3.input_value('#entry-date') == '2026-11-15' and all(expdays[ph] == d for ph, d in od3) and num(p3.inner_text('#total-outstanding')) == 11820
        p3.click('[data-customer="9000000105"] .cust-main'); p3.wait_for_selector('#txn-list')
        shown = p3.inner_text('#txn-list .txn >> nth=0')
        check('10d no UTC date shift in timezone %s' % tz, ok and '15 Sept 2026' in shown or ok and '15 Sep 2026' in shown, shown[:60])
        c3.close()

    check('Z no JS errors / native dialogs during run', not errors, errors)
    browser.close()

passed = sum(r['pass'] for r in results)
print('\n%d/%d checks passed' % (passed, len(results)))
(ROOT / 'tests' / 'report.json').write_text(json.dumps({'base': BASE, 'passed': passed, 'total': len(results), 'results': results}, indent=1))
sys.exit(0 if passed == len(results) else 1)
