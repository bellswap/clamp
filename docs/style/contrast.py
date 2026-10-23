"""Check WCAG contrast of the text tokens in site/src/styles/tokens.css.
Usage: python3 -I docs/style/contrast.py site/src/styles/tokens.css
Exit 1 if any text token falls below 4.5:1 on bg, surface or surface-2 in either theme."""
import re, sys

def lum(h):
    h = h.lstrip('#'); r, g, b = [int(h[i:i+2], 16) / 255 for i in (0, 2, 4)]
    f = lambda c: c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)

def ratio(a, b):
    la, lb = sorted([lum(a), lum(b)], reverse=True)
    return (la + 0.05) / (lb + 0.05)

css = open(sys.argv[1]).read()
blocks = {
    'dark': css.split('/* ---------- colour: light')[0],
    'light': css.split(':root[data-theme="light"]')[1].split('}')[0],
}
fail = 0
for name, block in blocks.items():
    tok = dict(re.findall(r'--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})', block))
    for fg in ('text', 'muted', 'up', 'down', 'accent'):
        for bg in ('bg', 'surface', 'surface-2'):
            r = ratio(tok[fg], tok[bg]); ok = r >= 4.5; fail += not ok
            print(f"{name:5} {fg:7} on {bg:9} {r:5.2f} {'ok' if ok else 'FAIL'}")
    r = ratio(tok['on-accent'], tok['accent']); ok = r >= 4.5; fail += not ok
    print(f"{name:5} on-accent on accent    {r:5.2f} {'ok' if ok else 'FAIL'}")
print('checks failed:', fail)
sys.exit(1 if fail else 0)
