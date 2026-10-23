# Bellswap v2 style spec

Status: the style rules of the playground site, written 2026-10-18 before the site was built.
Tokens: site/src/styles/tokens.css (the code is the source of truth for values; this page gives the rules).
Contrast proof: `python3 -I docs/style/contrast.py site/src/styles/tokens.css` (exit 0, every text token at 4.5:1 or better on bg, surface and surface-2 in both themes).

## 1. Identity

The product in one line: a ticket is a call on a price nobody on Bellswap sets; the loss stops at the stake; the print at expiry decides.

The bell, the ship and the tanker are out. The look matches bellswap.fun (updated 2026-10-22): black ground, neon #CCFF00 accent, Archivo, hairline borders, square 2 px corners. The new metaphor is **the print**: the reference price recorded at the ticket's expiry. Markets already say "the print" for the number that settles an argument, and it needs no illustration. Everything visual follows from two objects:

1. **The ticket.** A card in two halves separated by a perforation (a 1 px dashed line, `--perf`). The upper half is the call (ticker, side, multiple, stake, horizon). The lower half is empty while the ticket is open and fills with the result when the print arrives. The perforation is the brand's only ornament.
2. **The print.** One large tabular number with its timestamp and source, shown once per ticket at the verdict. It is the only place apart from the primary button where the accent colour appears.

Tone: calm, exact, fast. A trading tool with a game's tempo, not a game's decoration. No mascots, no confetti, no celebration tied to how often someone trades (the Massachusetts securities consent order of 2024-01-18 names "celebratory imagery directly tied to frequency of trading").

Brand mark: the wordmark "bellswap" in `--font-sans` semibold, lowercase, `--text`, with a 20 by 20 glyph to its left: the split wick (d1c), two stepped bell halves in `--text` around a vertical wick in `--accent` that runs from above the crown to below the lip, a bell and a candlestick in one form, drawn on a 64-unit grid with square corners only. The same mark on a black square is the favicon (`public/favicon.svg`, `apple-touch-icon.png`); the share card draws it in the footer. No other logo art.

### What the references taught (conventions studied, nothing copied)

| Reference | Keep the convention | Avoid |
| --- | --- | --- |
| Hyperliquid xyz:SP500 | dark terminal density, tabular numbers, Long and Short as one split control | the same risk text twice: a full-width banner plus a blocking modal with a checkbox before any interaction |
| Polymarket | one big two-way choice per card; the probability or payout is the hero number; "Up or Down" cards with a small gauge | carousels and promo tiles competing with the board |
| Kalshi | "Pays out 1.55x" next to the price: the payout multiple as a first-class number | serif-style display headlines on a trading surface |
| Ostium | leverage as one compact selector ("10x"), amount field with quick chips (50 percent, Max), the accent only on the submit button | candlestick terminal as the first screen for a casual visitor |
| trade.xyz landing | one headline, one action, small mono micro copy, a lot of air | full-bleed illustration (we have no art and want none) |
| First Bellswap demo | the dense grid, sparklines on every tile, two-letter monograms, tabular figures, the right rail | lime neon, bell and tanker art, the activity marquee, six headline counters, coloured monogram circles, a status word on every tile |

## 2. Colour

Two themes; dark is the default, light follows the system. All values in tokens.css.

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--bg` | #000000 | #F6F6F3 | page |
| `--surface` | #0C0E0A | #FFFFFF | cards, sheets |
| `--surface-2` | #151810 | #EFEFEB | inputs, segments, nested panels |
| `--border` | #23261F | #E2E2DD | hairlines |
| `--border-strong` | #3A3E33 | #CACAC3 | selected segment edge, the network switch outline |
| `--text` | #F4F5F0 | #131417 | primary text, numbers |
| `--muted` | #8E948A | #5C6170 | labels, timestamps (5.36:1 or better everywhere) |
| `--faint` | #5E6459 | #B4B6BC | decoration only: grid lines, perforation, sparkline baseline; never text |
| `--up` | #CCFF00 | #0A754C | long, gain, in the money |
| `--down` | #FF6A3D | #C42F45 | short, loss, out of the money |
| `--accent` (neon) | #CCFF00 | #4146D8 | the primary action, the active nav item and network segment, the verdict moment |
| `--on-accent` | #000000 | #FFFFFF | text on the accent |

The dark values are bellswap.fun's dark theme (the tokens.css of the bellswap.fun site); index.html forces `data-theme="dark"` as bellswap.fun does. Tints `--up-soft`, `--down-soft` and `--accent-soft` are the hue at 14 percent.

Rules:

- One accent. The neon is bellswap.fun's, so the play app and the mainnet app read as one product. It appears on: the primary button of the current screen (one per screen), the active header nav item (neon text with a 2 px bottom line), the active segment of the Mainnet | Playground switch, the ring of the verdict card, the print figure. It never marks a link, a chart line or a badge. Up shares the neon hue, so up values always carry a sign or the word Long.
- Up and down are never the only carrier of meaning: a signed number (+2.41 %, −1.08 %), the word Long or Short, or an arrow glyph stands next to every coloured value (colour blind users, screenshots in greyscale).
- Tints (`--up-soft`, `--down-soft`) only behind a value of the same hue: the side chip, the payout meter fill, the sparkline area.
- No gradients on chrome, no glow, no shadows except on sheets and popovers (`--shadow-sheet`, `--shadow-pop`).
- Charts: sparklines use `--up` or `--down` by the window's sign with a 12 percent area tint, baseline in `--faint`. Nothing else is plotted in colour.

## 3. Type

- Fonts: Archivo (OFL, variable weight 100 to 900) self-hosted from site/src/styles/fonts/archivo.ttf with its licence at site/public/fonts/OFL-Archivo.txt (the landing bundles landing/src/styles/fonts/archivo.ttf and ships the same licence at landing/public/fonts/OFL-Archivo.txt), never a CDN font; `--font-mono` stays the system monospace stack.
- Every number uses tabular figures: `font-variant-numeric: tabular-nums` plus `font-feature-settings: var(--num-features)`. Numbers are set in `--font-sans`; `--font-mono` is reserved for addresses, transaction hashes and the share card's footer line.
- Scale (px): 11, 12, 13, 15, 17, 20, 28, 40, 56, 80 (`--t-2xs` to `--t-5xl`). The app never goes above 40; 56 and 80 belong to the landing.
- Weights: 400 body, 500 labels and numbers in rows, 600 titles and the primary button, 700 only for the print and the verdict figure.
- Sizes 28 and up use `--tracking-tight` and `--lh-tight`. Micro labels (11 to 12) may be uppercase with `--tracking-label`; never more than three words in uppercase.
- Number formats: prices to the reference's precision (two decimals for most stocks), moves as signed percent with two decimals and a real minus sign (U+2212), amounts as "20 USDG" (integer when whole), multiples as "5x", times as "14:32:05" or "2h 14m". Addresses shortened to 0x1234…abcd in mono.

## 4. Space, radius, lines

- 4 px base: 4, 8, 12, 16, 20, 24, 32, 40, 56, 80, 120 (`--s-1` to `--s-30`).
- Side gutter 16 px on phones, 24 px from 768 px. App max width 1280 px; landing prose column 640 px.
- Ticker row 56 px; every hit target 44 px or larger.
- Radius: 2 px everywhere (`--r-xs`, `--r-s`, `--r-m`, `--r-l`, `--r-pill` are all 2 px, as bellswap.fun renders), including the toggle knob. Only the round status dot stays round. The Mainnet | Playground switch has 0 radius.
- Lines: 1 px `--border` between rows and around cards; cards on `--bg` use `--surface` and a border, never a shadow.

## 5. Motion

Three things move. Everything else changes state without movement (hover and press are an 80 ms colour change).

| What | How | Duration |
| --- | --- | --- |
| The countdown | digits step once a second (no flip, no bounce); a 2 px progress line along the ticket's top edge shrinks linearly to zero at expiry | `--d-tick` 1000 ms, linear |
| The payout meter | the fill follows stake, multiple and the live reference move | `--d-meter` 240 ms, `--ease-out` |
| The verdict reveal | the lower half of the ticket rises from the perforation (translateY 12 px to 0, opacity 0 to 1), then the payout figure counts from the stake to its final value; the accent ring fades in last | `--d-verdict` 640 ms total, `--ease-out` |

The ticket sheet's entrance (`--d-sheet` 280 ms) counts as part of the ticket flow, not a fourth animation. `prefers-reduced-motion: reduce` sets meter, verdict and sheet to 0 ms; the countdown keeps stepping (it is information) but the progress line stops animating and jumps per second. No sound by default.

## 6. Iconography

- Tickers: a two-letter monogram in a 28 by 28 square (`--r-xs`, 2 px), `--surface-2` fill, `--muted` text, 11 px semibold. No company logos, no per-ticker colours (the first demo's coloured circles are gone). The letters are the first two of the symbol (NVDA becomes NV; a single-letter symbol pads with its second letter of the name).
- Interface icons: a single stroke set at 1.5 px on a 20 px grid, drawn inline as SVG (search, close, chevron, arrow up right for external links, copy, settings). Up and down arrows are the only filled glyphs. No emoji anywhere.
- The brand glyph (section 1) and the perforation line are the only ornaments.

## 7. Components

Each component lists its parts and states. Words in quotes are placeholders, not final copy.

1. **Ticker row** (board, 56 px): monogram, symbol (17 px, 500) over the name (13 px muted, one line, ellipsis), sparkline 72 by 24 for the selected window, reference price (tabular), window move as a signed percent in up or down, then two compact buttons "Long" and "Short" (each 44 by 32, `--surface-2`, text in up or down). Tapping the row body opens the ticker detail; tapping Long or Short opens the ticket sheet with that side preselected. Hover: row background `--surface`. Desktop: the same row in a dense table; at 1024 px and wider the board can switch to a three-column card grid (sparkline 100 percent width), the first demo's density without its labels.
2. **Ticket card**: the two-half ticket. Upper half: monogram, symbol, side chip (pill, tint plus text: "Long" or "Short"), multiple, stake, horizon, opened time. Perforation. Lower half while open: entry price, live price, live move, payout meter, countdown. Lower half at settlement: the verdict (component 7). States: open, settling (countdown at zero, a muted "Waiting for the print" line), won, lost, refunded (stale reference; muted, stake returned).
3. **Multiple selector**: a segmented control 1x, 2x, 5x, 10x, 20x (five segments, equal width, `--surface-2`, selected segment `--surface` with `--border-strong`). Below it, in muted 12 px: the worst case and the best case for the current stake ("lose at most 20 USDG · win up to 100 USDG"). Custom multiples are not offered on the playground.
4. **Stake input**: a numeric field (17 px, tabular, suffix "USDG") with four chips under it: 5, 20, 50, 100. Default 20. Shows the wallet balance on the right in muted text; a value above the balance turns the field border `--down` and disables the primary button (no extra warning text).
5. **Horizon selector**: segmented Session, Day, Week; each segment shows the expiry time under its label in 11 px muted.
6. **Payout meter**: a horizontal bar from 0 to the cap (stake times multiple). A tick marks the stake (break even). The fill shows the current payout: `--up-soft` with an `--up` edge above the stake tick, `--down-soft` with a `--down` edge below it. Above the bar, left: "Payout" label; right: the current payout figure (20 px tabular, up or down). Under the bar: 0 at the left, the cap at the right, both muted. Animates with `--d-meter`. In the ticket sheet before opening, the meter shows the static range with the stake tick and no fill.
7. **Countdown**: digits only (`--t-2xl` on the ticket sheet, `--t-3xl` on watch), tabular, `--text`; under 60 s left the digits stay the same colour (no red, no pulsing). The progress line rides the top edge of the ticket card.
8. **Verdict card**: the ticket's lower half filled. The print (reference value at expiry, `--t-3xl`, weight 700, `--accent`), its timestamp and source in 12 px muted; the move from entry as a signed percent; the payout figure (`--t-3xl`, up or down); a 1 px `--accent` ring around the whole ticket (`--accent-soft` 4 px outside it). Two buttons: "Share" (primary, accent) and "Again" (secondary, same ticker, side and multiple). One per verdict; a loss gets the same restrained treatment as a win.
9. **Share card** (1200 by 630, rendered server side or on a canvas, PNG): background `--bg` dark always; left 60 percent: monogram (96 px), symbol (64 px), side chip and multiple, the entry and the print as two lines ("Entry 182.40", "Print 186.15"), the move; right 40 percent: the payout as the hero (120 px, up or down), the stake under it; a perforation line separating top 520 px from a 110 px footer; footer: the brand glyph and wordmark at the left, "Take the other side" plus the short link at the right in mono, and the surface's one disclaimer line in 18 px muted. No avatar, no address unless the user chooses to show it.
10. **Leaderboard row**: rank (tabular, muted), shortened address or chosen handle, tickets settled, realized ROI as a signed percent (the ranking value), realized PnL in USDG. Minimum settled stake to qualify is shown once in the header. Never ranked by volume or ticket count. The viewer's own row is pinned at the top with `--surface-2`.
11. **Vault panel**: four figures in a 2 by 2 grid: Vault size, Reserved for open tickets (the booked worst case), Free, Your share. A thin stacked bar under them shows reserved against free (reserved in `--muted` tint, free in `--surface-2`; no accent). Deposit and Withdraw as a segmented switch above one amount field and one button (that button is the screen's primary action, accent). The vault's realized PnL for 7 days as a sparkline with its signed figure.
12. **Toggle**: a 36 by 20 pill switch, off: `--surface-2` with a `--muted` knob; on: `--text` track with a `--bg` knob (not the accent, because the accent is reserved). Label to the left, never inside. The board's toggle reads "Show tickers Robinhood Chain lists" and is off by default.
13. **Toast**: one line, max 64 characters, `--surface` with `--border` and `--shadow-pop`, a 6 px status dot (up for success, down for failure, muted for info) before the text, auto-dismiss after 4 s, at most one visible. Phone: above the tab bar. Desktop: bottom right. Transaction toasts link "View" to the activity entry.
14. **Empty states**: one muted line and at most one button, centred in the space the content would take; no illustration. Examples (placeholders): Me with no tickets: "No tickets yet." + "Open one"; Activity filtered to nothing: "Nothing matches."; Leaders before the first settlement: "The board fills after the first print."
15. **Disclaimer line** (section 10): one line, one place per surface.

## 8. Screens

Word budgets count visible words of interface copy on first paint, excluding ticker symbols, company names, numbers and the disclaimer line. Wireframes are for a 390 px phone unless marked; `[ ]` is a control, `( )` a chip or segment, `--- - ---` the perforation.

### 8.1 Board (route `/`), budget 25 words

```
bellswap ▣                    [0x12…ab · 1,000 USDG]
[Search ticker               ]
(1D)(5D)(1M)   Show tickers Robinhood Chain lists [ o]
---------------------------------------------------
NV  NVDA   ~~~/\~~   182.40   −3.12 %  [Long][Short]
    NVIDIA Corporation
AM  AMD    ~~\/~~~   141.06   −4.50 %  [Long][Short]
    Advanced Micro Devices, Inc.
...                                         (virtualized)
---------------------------------------------------
Playground: a fork of Robinhood Chain, recorded prices, no real money.
[Board] [Tickets] [Leaders] [More]
```

Desktop (1280): header with nav inline; the board as a table or a three-column grid (toggle in the filter row), a right rail 320 px wide with "Your open tickets" (compact ticket cards) and the vault panel summary. Sort: biggest move first by default, so falling stocks surface on a red day and Short is one tap away.

### 8.2 Ticket flow (sheet over the board), budget 30 words, two taps to open

Tap 1 is Long or Short on a row. The sheet opens with defaults (stake 20 USDG, 5x, Session) so tap 2 can be the primary button.

```
NV  NVDA   182.40  −3.12 %          [x]
( Long )( Short* )
Multiple   (1x)(2x)(5x*)(10x)(20x)
           lose at most 20 · win up to 100
Stake      [ 20              USDG ]   balance 1,000
           (5)(20*)(50)(100)
Horizon    (Session*)(Day)(Week)
            16:00       Fri      Oct 24
Payout  |----------|=====================| 100
        0        stake                  cap
[          Open ticket          ]   <- accent, primary
```

After the transaction confirms, the sheet becomes the open ticket card (no separate success page) and a toast says the ticket is open.

### 8.3 Watch (route `/t/:id`), budget 15 words

```
[<]                               Ticket #418
=========== progress line ===========
NV  NVDA   (Short)  5x   20 USDG   Session
- - - - - - - - - - - - - - - - - - - - -
            00:42
Entry 182.40      Now 181.10      −0.71 %
Payout |-----------|========|------| 27.13
Activity on this ticker  (3 lines, muted)
```

### 8.4 Verdict (same route at settlement), budget 15 words

```
NV  NVDA   (Short)  5x   20 USDG   Session
- - - - - - - - - - - - - - - - - - - - -
Print   180.92          16:00:00 · reference
Move    −0.81 %
Payout  20.81 USDG        (+0.81 USDG)
[ Share ]  [ Again ]
```

The accent ring frames the whole ticket; the print figure is the only accent text.

### 8.5 Me / Tickets (route `/me`), budget 20 words

```
Open (2)  Settled (14)          (segments)
[ticket card, compact]
[ticket card, compact]
Totals: settled 14 · ROI +6.2 % · PnL +31.40 USDG
[Faucet: 1,000 USDG]   [Export key]   [Connect wallet]
```

### 8.6 Leaders (route `/leaders`), budget 20 words

```
This week · ranked by realized ROI · min 100 USDG settled
 you  0x12…ab   9 tickets   +6.2 %   +31.40
  1   0x9f…02  22 tickets  +48.0 %  +410.00
  2   ...
```

### 8.7 Vault (route `/vault`), budget 30 words

```
Vault size 250,000     Reserved 41,200
Free      208,800      Your share 0.00 %
[reserved |#####-----------------| free]
7d PnL ~~~/~~  +1,240 USDG
(Deposit)(Withdraw)
[ amount            USDG ]
[         Deposit          ]   <- accent
How it works: 3 short lines (worst case booked at open, opposite tickets net, fee to the vault)
```

### 8.8 Activity (route `/activity`), budget 15 words

```
(All)(Opens)(Settlements)      [address filter]
14:32:05  0x9f…02  NVDA  Short 5x  20     open
14:31:50  0x12…ab  AMD   Long 2x   50     +11.20
...
```

Every row links to the ticket's watch or verdict page; addresses link to a per-address filter. This is the playground's explorer.

### Navigation

Phone: bottom tab bar with four tabs (Board, Tickets, Leaders, More; More holds Vault, Activity, Settings). Desktop: inline header nav with the same items, Vault and Activity promoted to the bar.

## 9. Landing (v2.bellswap.fun): visual voice

Same tokens, more air. Dark default, light by system.

- One column at `--maxw-read` (640 px) for prose; sections separated by `--s-30` (120 px) on desktop, `--s-20` on phones.
- Hero: the headline at `--t-5xl` (80 px, `--t-3xl` on phones), one sentence under it in `--muted`, one primary button (accent) to the playground and one text link to the deck. Next to or under the headline, a single real ticket card in its verdict state (rendered from the same component, static data), so the product is shown, not described.
- Story and roadmap as a vertical timeline: each step a dated row with a 1 px `--border` rail and a perforation tick at each node; past steps in `--muted`, "where we stand" in `--text` with the accent dot (the landing's verdict moment), next steps in `--text` without fill.
- Numbers as figures, not paragraphs: at most four stat figures on the page, each a large tabular number with a 12 px label.
- No stock photography, no 3D, no illustration beyond the ticket card and the brand glyph.
- The one disclaimer line sits in the footer.

## 10. The disclaimer line

One line per surface, in `--t-xs`, `--muted`, never repeated per element, never a modal, never a checkbox before use.

- App (every screen, the same line): a 32 px footer strip above the tab bar on phones, the page footer on desktop. Wording (placeholder, 12 words): "Playground on a fork of Robinhood Chain. Recorded prices, no real money."
- Share card: the same line in the footer (section 7, item 9).
- Landing: footer, one line: "Bellswap v2 is a playground on a fork of Robinhood Chain; nothing here is an offer."

If a reference goes stale, the affected ticket shows its own state (refunded) and the board row shows the price age in muted text; that is a state, not a second disclaimer.

## 11. Phone layout at 390 px

- Gutter 16 px; content width 358 px.
- Header 52 px: brand glyph and wordmark left, the Mainnet | Playground switch, wallet pill right (shortened address and USDG balance; tap opens Me). Below 600 px the wordmark is visually hidden (the brand link keeps its label) and the pill shows the address and the "ext" label only; below 390 px the "ext" label goes too. At every width the address truncates with an ellipsis rather than leave the gutter. Each switch link has a 44 px tall hit area inside its 28 px box.
- Search 44 px; filter row 40 px with the window segments and the toggle (the toggle label may wrap to two lines at 390; it stays a label, not a tooltip).
- Ticker row 56 px: monogram 28, symbol and name column flexible (min 96), sparkline 56 by 20 (shrinks from 72), price and move stacked right-aligned in one 72 px column, then Long and Short at 44 by 32 each. Total: 16 + 28 + 8 + 96 + 8 + 56 + 8 + 72 + 8 + 44 + 4 + 44 + 16 = 408; at 390 the name column takes the 18 px cut (min 78) and the name truncates.
- Ticket sheet: bottom sheet, max height 92 dvh, `--r-l` top corners, drag handle 4 by 32, the primary button pinned to the bottom of the sheet above the safe area inset.
- Tab bar 56 px plus the safe area inset; the disclaimer strip 32 px sits directly above it.
- No horizontal page scroll at any width; tables become stacked rows under 600 px.

## 12. Product name for the ticket

Three candidates, each short, free of ship and bell words, checked with one web search on 2026-10-18 for a live trading venue or app of that name (none found in the results):

1. **Clamp**: the payout is the stake times a value clamped between zero and the multiple, so the name is the mechanism; it reads as a noun and a verb ("open a Clamp on NVDA, short 5x"). Search: `"Clamp" crypto trading protocol leverage app`, no venue of that name in the results.
2. **Notch**: a notch on the multiple dial and the cut on a ticket stub; one syllable. Search: `"Notch" crypto trading app leverage exchange`, no venue; results surface Notcoin, a different name.
3. **Stub**: the ticket stub, literal and short. Search: `"Stub" trading app crypto perps prediction market`, no venue; risk: the word sits close to StubHub, a ticket resale brand, which invites confusion.

Recommendation: **Clamp**, because it names the one property the product sells (the loss stops at the stake and the win stops at the cap) and it pairs with the perforated ticket without needing a picture. A trademark search proper is a founder action before any public use.

## 13. Ticker page and chart (amendment, 2026-10-23)

Route `/t/:symbol` is a page, no longer a sheet over the board (site/src/pages/ticker/TickerPage.tsx).

- Layout at 1024 px and up: a stats strip on top (`--surface`, hairline cells: Last print, Since open, Session high, Session low, Open on SYM of its cap, Long / Short open stake, Vault exposure, Next settlement with its wall ETA, Playground clock), the candle chart two thirds and the ticket panel one third, the tabs Your tickets, Recent on SYM and Settled below. Under 1024 px: a compact stats block (price 28 px, move, a 3 by 2 grid), the chart at 290 px, rows stacked under 600 px, and a sticky Long / Short bar (48 px, tint fills, `--up` and `--down` text, never the accent) above the tab bar that opens the ticket sheet with the side set.
- Candles: up candles in `--up`, down candles in `--down`, bodies, borders and wicks alike. In the dark theme `--up` shares the neon hue; that is the up rule of section 2, not the accent role.
- The accent (lime as emphasis) appears on the ticker page in three places only: the primary button, the active interval chip (accent text on `--accent-soft`) and the active tab's 2 px underline. It never colours a chart line or series: grid and scale edges `--border`, axis text `--muted`, crosshair `--faint`, the viewer's entry lines dashed `--muted` with a side label ("Long 20x"), the preview line Pays nothing at dotted `--down`, Max payout at dotted `--muted`.
- Under the chart, one source line in 11 px `--muted`: "Recorded 5-minute prices, replayed on the playground clock." It is the only freshness note on the page.
- "Settles at" replaces "Horizon": one control showing the chosen settlement as "Today's close, 21:00 (52 s)" (playground time, wall ETA in parentheses), a chevron opening three rows (Today's close, In 24 h, In 7 d), and the countdown line "Settles in 3 min 7 s" under it. Today's close is the default; In 24 h is the default when the close is under 15 wall seconds away. Cards and rows name the three as "Today's close", "In 24 h", "In 7 d" (site/src/lib/ticker/settles-at.ts settlesName).
- Summary rows under the payout meter, label `--muted` left and value tabular right: Max payout, Max loss, Break even at, Pays nothing at, Fee. The primary button reads "Open Long · 20 USDG"; with a zero balance it is "Get test USDG"; before the market's first fresh print it is "Preparing market" (disabled); a symbol without a recorded series shows "No price feed" in place of the chart and the form.
- Demo trader rows carry the tag "demo" (11 px, `--border-strong` hairline, `--muted` text) with the title "Demo trader. Opens tickets on a timer."
- Chart library: TradingView Lightweight Charts 5.2.1, vendored under site/src/vendor/lightweight-charts with its sha256 pinned by a test, its licence and notice in site/public/licenses, and the attribution logo on.
