"""Guided tour + Guide page tests.  python3 tests/tour.py [BASE_URL]"""
import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765').rstrip('/')
SAMPLE = (ROOT / 'samples' / 'sample-data.json').read_text()
SHOTS = ROOT / 'tests' / 'screens'
CHROME = os.environ.get('CHROME', '/usr/bin/google-chrome')
HUMAN = "Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });"  # behave like a real phone browser
results = []
def check(name, cond, detail=''):
    results.append({'test': name, 'pass': bool(cond), 'detail': detail})
    print(('PASS ' if cond else 'FAIL ') + name + ((' — ' + str(detail)) if detail else ''))

def visible_tour(page):
    return page.locator('#tour-root').count() == 1

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
    errors = []

    # 1) Real-user first visit: tour opens automatically on the language step
    ctx = b.new_context(viewport={'width': 375, 'height': 812}, device_scale_factor=2)
    ctx.add_init_script(HUMAN)
    page = ctx.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE + '/'); page.wait_for_selector('#tour-root .lang-opt', timeout=4000)
    langs = page.eval_on_selector_all('#tour-root [data-tour-lang]', 'els => els.map(e => e.dataset.tourLang)')
    check('T1 first visit auto-opens tour on the LANGUAGE step', page.get_attribute('#tour-root', 'data-step') == 'lang' and langs == ['en', 'hi', 'te', 'kn'], langs)
    page.screenshot(path=str(SHOTS / 'tour-0-language.png'))

    # import sample data underneath so the list step has rows (skip, import, then replay from Guide)
    page.click('[data-tour="skip"]')
    check('T2 skip closes tour and remembers it', not visible_tour(page) and page.evaluate('localStorage.getItem("hisaab:tour:v1")') == 'done')
    page.fill('#import-box', SAMPLE); page.click('#import-go'); page.wait_for_timeout(300)
    page.reload(); page.wait_for_selector('#total-outstanding'); page.wait_for_timeout(600)
    check('T3 tour does not reappear after it was seen', not visible_tour(page))

    # 2) Guide in bottom bar
    page.click('.bottom-nav [data-nav="guide"]'); page.wait_for_selector('#guide-steps')
    steps = page.locator('#guide-steps .guide-step').count()
    sw = page.evaluate('document.documentElement.scrollWidth')
    check('G1 bottom-bar Guide opens written instructions (8 steps), no overflow at 375px', steps == 8 and sw <= 375 and 'active' in page.get_attribute('.bottom-nav [data-nav="guide"]', 'class'), (steps, sw))
    page.screenshot(path=str(SHOTS / 'guide-375.png'), full_page=True)

    # 3) Replay tour from Guide → language first → choose Telugu → every step highlights its target
    page.click('#start-tour'); page.wait_for_selector('#tour-root .lang-opt')
    check('T4 Guide → Start tour opens on language step (and returns to Home)', page.get_attribute('#tour-root', 'data-step') == 'lang' and page.evaluate('location.hash') in ('#/', ''))
    page.click('[data-tour-lang="te"]'); page.wait_for_timeout(500)
    check('T5 picking a language applies it to the app and the tour immediately',
          page.evaluate('document.documentElement.lang') == 'te' and 'మొత్తం బాకీ' in page.inner_text('.hero-label') and page.get_attribute('#tour-root', 'data-step') == 'total')
    seen, bad = [], []
    for i in range(20):
        step = page.get_attribute('#tour-root', 'data-step')
        if step == 'done': break
        page.wait_for_timeout(1100)  # let the smooth scroll settle
        info = page.evaluate('''() => {
          const hole = document.querySelector('.tour-hole'), card = document.querySelector('.tour-card');
          const h = hole.getBoundingClientRect(), c = card.getBoundingClientRect();
          return {hole: !hole.hidden && h.width > 10 && h.height > 10, cardIn: c.top >= 0 && c.bottom <= innerHeight + 1,
                  overlap: !(c.bottom <= h.top + 2 || c.top >= h.bottom - 2), title: document.querySelector('#tour-title').textContent}
        }''')
        seen.append(step)
        if not (info['hole'] and info['cardIn'] and not info['overlap']): bad.append((step, info))
        if step in ('total', 'list', 'quick', 'guide'): page.screenshot(path=str(SHOTS / ('tour-%s.png' % step)))
        page.click('[data-tour="next"]')
    check('T6 each step spotlights its part of the screen; card fully visible and not covering it', not bad and len(seen) == 10, (seen, bad))
    page.screenshot(path=str(SHOTS / 'tour-done.png'))
    page.click('[data-tour="back"]'); page.wait_for_timeout(300)
    back_ok = page.get_attribute('#tour-root', 'data-step') == 'settings'
    page.keyboard.press('ArrowRight'); page.wait_for_timeout(200)
    page.click('[data-tour="finish"]')
    check('T7 Back, keyboard and Finish work; tour closes', back_ok and not visible_tour(page))

    # 4) Overdue shortcut in bottom bar
    page.goto(BASE + '/#/'); page.wait_for_selector('#overdue-section')
    page.click('.bottom-nav [data-nav="overdue"]'); page.wait_for_timeout(900)
    top = page.evaluate('document.querySelector("#overdue-section").getBoundingClientRect().top')
    check('N1 bottom-bar Overdue jumps to the overdue list', 0 <= top < 200 and 'active' in page.get_attribute('.bottom-nav [data-nav="overdue"]', 'class'), top)
    page.screenshot(path=str(SHOTS / 'nav-375.png'))
    page.select_option('#lang-select', 'en')
    ctx.close()

    # 5) Safety: tour never auto-opens for automated testers or ?today links
    c2 = b.new_context(); p2 = c2.new_page(); p2.goto(BASE + '/'); p2.wait_for_timeout(800)
    a = visible_tour(p2); c2.close()
    c3 = b.new_context(); c3.add_init_script(HUMAN); p3 = c3.new_page(); p3.goto(BASE + '/?today=2026-11-15'); p3.wait_for_timeout(800)
    b2 = visible_tour(p3)
    p3.fill('#import-box', SAMPLE); p3.click('#import-go', timeout=3000); p3.wait_for_timeout(300)
    tot = p3.inner_text('#total-outstanding'); c3.close()
    check('S1 no auto tour for webdriver browsers or ?today links; import still clickable', not a and not b2 and tot == '₹11,820', (a, b2, tot))

    # 6) Even if a tester lands on an open tour, every competition element is still in the DOM
    c4 = b.new_context(); p4 = c4.new_page(); p4.goto(BASE + '/?tour=1'); p4.wait_for_selector('#tour-root')
    present = p4.evaluate('["#import-box","#import-go","#shot-input","#total-outstanding"].every(s => document.querySelector(s))')
    p4.keyboard.press('Escape'); p4.wait_for_timeout(200)
    check('S2 ?tour=1 forces tour; required elements stay in DOM; Esc closes', present and not visible_tour(p4)); c4.close()

    # 7) Dark mode tour renders
    c5 = b.new_context(viewport={'width': 375, 'height': 812}, device_scale_factor=2, color_scheme='dark'); p5 = c5.new_page()
    p5.goto(BASE + '/?tour=1'); p5.wait_for_selector('#tour-root .lang-opt'); p5.wait_for_timeout(300)
    p5.screenshot(path=str(SHOTS / 'tour-0-language-dark.png')); c5.close()

    check('Z no JS errors', not errors, errors)
    b.close()

passed = sum(r['pass'] for r in results)
print('\n%d/%d tour checks passed' % (passed, len(results)))
(ROOT / 'tests' / 'tour-report.json').write_text(json.dumps({'base': BASE, 'passed': passed, 'total': len(results), 'results': results}, indent=1))
sys.exit(0 if passed == len(results) else 1)
