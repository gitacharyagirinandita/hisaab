# Hisaab – Testing Report

Automated run: headless Chrome (Playwright), 375×812 viewport, base `http://127.0.0.1:8765`.

**Result: 43/43 checks passed.**

| # | Check | Result | Detail |
|---|---|---|---|
| 05 | import textarea #import-box exists | ✅ Pass |  |
| 06 | import button #import-go exists | ✅ Pass |  |
| 07 | payment screenshot input#shot-input[type=file] exists | ✅ Pass |  |
| 01 | total outstanding = 11820 | ✅ Pass | ₹11,820 |
| 02 | one customer row per phone | ✅ Pass | ['9000000102', '9000000106', '9000000103', '9000000104', '9000000101', '9000000108', '9000000107', '9000000105'] |
| 03 | every customer balance matches sample-expected.json | ✅ Pass | all 8 match |
| 01b | total equals sum of positive balances | ✅ Pass |  |
| 01c | customers_with_balance = 8 | ✅ Pass |  |
| 01d | top defaulter listed first (9000000102) | ✅ Pass | 9000000102 |
| 04 | WhatsApp a[data-remind] → wa.me/91<phone>?text= with name + balance | ✅ Pass | all 8 ok |
| 04b | reminder opens in new tab, not auto-sent | ✅ Pass |  |
| 13 | search by name and phone | ✅ Pass | [['9000000102'], ['9000000105'], 0] |
| 16 | overdue list sorted by days since last payment (desc) | ✅ Pass | [['9000000105', 61], ['9000000104', 44], ['9000000108', 43], ['9000000102', 42], ['9000000106', 27], ['9000000103', 27], ['9000000107', 24], |
| 16b | overdue day counts correct vs ?today=2026-11-15 | ✅ Pass | {'9000000101': 21, '9000000102': 42, '9000000103': 27, '9000000104': 44, '9000000105': 61, '9000000106': 27, '9000000107': 24, '9000000108': |
| 10 | ?today sets default entry date | ✅ Pass | 2026-11-15 |
| 09 | customer history newest first | ✅ Pass | ['2026-10-25', '2026-10-23', '2026-10-19', '2026-10-10', '2026-10-06', '2026-09-27'] |
| 05b | account page shows balance | ✅ Pass |  |
| 10b | account page entry date uses ?today | ✅ Pass |  |
| 08 | saved payment shows img[data-shot] thumbnail (preview before save: True) | ✅ Pass | {'src': 'data:image/png;base64,', 'w': 2} |
| 06b | balance recalculated after payment (670-170=500) | ✅ Pass |  |
| 09b | new entry on 2026-11-15 shows first | ✅ Pass | ['2026-11-15', 'payment', '170'] |
| 06c | zero and negative amounts rejected | ✅ Pass | [True, True, 7] |
| 11 | data + screenshot survive refresh | ✅ Pass |  |
| 14 | edit (balance 400) and delete (balance 670) recalculate | ✅ Pass | [400.0, 670.0] |
| 14b | dashboard total back to 11820 after edit+delete | ✅ Pass |  |
| 15 | CSV export rows match ledger (38 entries, balances match) | ✅ Pass | 38 |
| 19 | UPI link in reminder when configured (invalid UPI rejected) | ✅ Pass | store@okaxis&pn=Lakshmi%20Provision%20Store%20(fictional)&am=3470.00&cu=INR&tn=Hisaab%20dues  Thank you for your support!  - Lakshmi Provisi |
| 19b | no UPI link before configured | ✅ Pass |  |
| 20 | Hindi / Telugu / Kannada labels (numbers unchanged, persisted) | ✅ Pass | ['बकाया सूची\n8 \| कुल बकाया', 'మొత్తం బాకీ', 'ಒಟ್ಟು ಬಾಕಿ'] |
| 18 | light/dark modes switch and persist | ✅ Pass | ['rgb(243, 246, 244)', 'rgb(11, 20, 17)'] |
| 17 | no horizontal scroll at 375px (all views) | ✅ Pass | {'#/': 375, '#/settings': 375, 'account': 375, 'add-sheet': 375} |
| C1 | add customer: duplicate + invalid phone rejected, opening balance works | ✅ Pass |  |
| 12a | malformed JSON → clear error, data untouched | ✅ Pass | ['Import failed. This is not valid JSON (Expected double-quoted property name in J', 'Import failed. JSON must contain a "customers" list.'] |
| 12 | different shop JSON replaces old shop (no silent merge), skips invalid rows | ✅ Pass | [1499.5, {'8123456789': 1200.0, '9876543210': 299.5, '7000000001': 0.0}, 'Import complete. Loaded "Sri Sai Stationery (test)": 3 customers,  |
| 12b | user text escaped (no HTML injection) | ✅ Pass |  |
| 04c | zero-balance customer gets no payment-due reminder | ✅ Pass | https://wa.me/917000000001?text=Hello Zero Balance ji!  Your account with us is fully settled. No payment is due.  Thank |
| 12c | merge of unrelated shop data refused with message | ✅ Pass |  |
| 12d | re-import sample → 11820 again; previous shop kept as auto-backup | ✅ Pass |  |
| 11b | data survives closing and reopening the tab | ✅ Pass |  |
| 10c | without ?today the entry date is the local date | ✅ Pass | 2026-11-17 |
| 10d | no UTC date shift in timezone Pacific/Honolulu | ✅ Pass | paid on UPI PAYMENT 15 Sept 2026 · Bal ₹230 − ₹230 |
| 10d | no UTC date shift in timezone Pacific/Kiritimati | ✅ Pass | paid on UPI PAYMENT 15 Sept 2026 · Bal ₹230 − ₹230 |
| Z | no JS errors / native dialogs during run | ✅ Pass | [] |

## Guided tour & Guide page (`tests/tour.py`)

**Result: 12/12 checks passed** (375×812, headless Chrome).

| # | Check | Result |
|---|---|---|
| T1 | first visit auto-opens tour on the LANGUAGE step | ✅ Pass |
| T2 | skip closes tour and remembers it | ✅ Pass |
| T3 | tour does not reappear after it was seen | ✅ Pass |
| G1 | bottom-bar Guide opens written instructions (8 steps), no overflow at 375px | ✅ Pass |
| T4 | Guide → Start tour opens on language step (and returns to Home) | ✅ Pass |
| T5 | picking a language applies it to the app and the tour immediately | ✅ Pass |
| T6 | each step spotlights its part of the screen; card fully visible and not covering it | ✅ Pass |
| T7 | Back, keyboard and Finish work; tour closes | ✅ Pass |
| N1 | bottom-bar Overdue jumps to the overdue list | ✅ Pass |
| S1 | no auto tour for webdriver browsers or ?today links; import still clickable | ✅ Pass |
| S2 | ?tour=1 forces tour; required elements stay in DOM; Esc closes | ✅ Pass |
| Z | no JS errors | ✅ Pass |

## Readability (light + dark) – `tests/contrast.py`

Every visible text element on Home, Customer account, Settings, Guide and the tour was measured for WCAG contrast at 375px in both themes.

| Theme | Text elements checked | Lowest contrast ratio | Below WCAG AA |
|---|---|---|---|
| Light | 505 | 4.51:1 | 0 |
| Dark | 505 | 5.58:1 | 0 |

The first run found 9 real failures (white text on the lightest part of the green header gradient: 2.9–3.7:1, and the "Remind" label: 3.94:1). They were fixed by darkening the gradient stops and the label colour.

## Sample data comparison (`?today=2026-11-15`)

| Phone | Expected | Hisaab | Match |
|---|---|---|---|
| 9000000101 | 670 | 670 | ✅ |
| 9000000102 | 3470 | 3470 | ✅ |
| 9000000103 | 2810 | 2810 | ✅ |
| 9000000104 | 1260 | 1260 | ✅ |
| 9000000105 | 230 | 230 | ✅ |
| 9000000106 | 2830 | 2830 | ✅ |
| 9000000107 | 250 | 250 | ✅ |
| 9000000108 | 300 | 300 | ✅ |
| **Total outstanding** | **11820** | **11820** | ✅ |
| Top defaulter | 9000000102 | 9000000102 (listed first) | ✅ |
| Customers with balance | 8 | 8 | ✅ |

Values in the Hisaab column were read from the rendered DOM (`#total-outstanding`, `[data-customer] [data-balance]`) by test checks 01–03 above.

Screenshots: `tests/screens/`.

## Live deployment check – https://hisaab-zeta-two.vercel.app

Run on 2026-11-17 against the production Vercel deployment, in a real browser (Claude desktop browser pane), using the deployed `samples/` files.

| Check | Result |
|---|---|
| `#import-box`, `#import-go`, `input#shot-input` present | ✅ |
| `?today=2026-11-15` sets default entry date | ✅ |
| Import sample → `#total-outstanding` = ₹11,820 | ✅ |
| 8 rows, one per phone; all 8 `[data-balance]` match expected | ✅ |
| All 8 `a[data-remind]` → `https://wa.me/91<phone>?text=…` with name and `Rs <balance>` | ✅ |
| Search by name (`sunita`) and phone (`0105`) | ✅ |
| Overdue sorted by days since last payment (61, 44, 43, 42, 27, 27, 24, 21) | ✅ |
| Customer history newest first | ✅ |
| Payment with screenshot → preview, then `img[data-shot]` thumbnail; balance 670 → 500 | ✅ |
| Edit entry (→ 400) and delete (→ 670) recalculate | ✅ |
| CSV export: 38 rows, per-customer totals equal expected balances | ✅ |
| UPI ID configured → `upi://pay?pa=…&am=3470.00` in reminder | ✅ |
| Hindi / Telugu / Kannada labels, amounts unchanged | ✅ |
| Light ↔ dark toggle | ✅ |
| Reload → data persists (₹11,820, 8 customers) | ✅ |
| No `?today` → local date (2026-11-17) | ✅ |
| 375 × 812 viewport: `scrollWidth` = 375 (no horizontal scroll) | ✅ |
