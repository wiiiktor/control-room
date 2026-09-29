#!/usr/bin/env python3
"""WCAG contrast for every control-room theme, measured rather than eyeballed.

A colour theme is not readable because it looks nice in a screenshot; it is readable when the
contrast ratio between each piece of text and the surface behind it clears the threshold. This
parses the :root[data-theme=...] blocks straight out of extension/chat.html and reports every pair
that matters for TEXT, including the dimmed tiers, which are composited over their ground first --
an opacity is a colour change, and .45 ink on a dark paper is where a theme actually fails.

  4.5:1  body text          (WCAG AA)
  3.0:1  large text and UI  (AA large / non-text)

  tools/contrast.py [theme ...]
"""
import re, sys, os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(HERE, "extension", "chat.html")


def parse():
    """Model the cascade instead of guessing at it.

    Every `:root...{ }` block is read in source order with its selector list, then applied per theme
    the way the browser would: a bare `:root` (0,1,0) applies to every theme, `:root[data-theme]`
    and `:root[data-theme="x"]` are both (0,1,1), and among equal specificity the later block wins.
    ⛔ The first version of this script pattern-matched one selector shape and silently ignored a
    late `:root, :root[data-theme]` override -- it reported twenty failures that the stylesheet had
    already fixed. A checker that cannot see half the cascade is not checking the cascade.
    """
    s = open(SRC).read()
    blocks = []
    for m in re.finditer(r'((?::root[^\n{,]*)(?:,\s*:root[^\n{,]*)*)\s*\{(.*?)\n  \}', s, re.S):
        sel = m.group(1)
        toks = dict(re.findall(r'--([a-z0-9-]+):\s*([^;]+);', m.group(2)))
        if not toks:
            continue
        parts = [x.strip() for x in sel.split(',')]
        blocks.append((parts, {k: v.strip() for k, v in toks.items()}))

    names = set()
    for parts, _ in blocks:
        for p_ in parts:
            mm = re.match(r':root\[data-theme="([a-z]+)"\]$', p_)
            if mm:
                names.add(mm.group(1))
    names.add("dark")

    out = {}
    for name in sorted(names):
        eff = {}
        for spec_pass in (0, 1):                      # (0,1,0) first, then (0,1,1)
            for parts, toks in blocks:
                for p_ in parts:
                    if p_ == ":root":
                        hit, spec = True, 0
                    elif p_ == ":root[data-theme]":
                        hit, spec = True, 1
                    elif p_ == f':root[data-theme="{name}"]':
                        hit, spec = True, 1
                    else:
                        continue
                    if hit and spec == spec_pass:
                        eff.update(toks)
        if "ink" in eff:
            out[name] = eff
    return out


def rgb(c):
    c = c.strip()
    m = re.match(r'rgba?\(([^)]+)\)', c)
    if m:
        p = [x.strip() for x in m.group(1).split(',')]
        return (float(p[0]), float(p[1]), float(p[2]), float(p[3]) if len(p) > 3 else 1.0)
    c = c.lstrip('#')
    if len(c) == 3:
        c = ''.join(x * 2 for x in c)
    if len(c) == 8:
        return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), int(c[6:8], 16) / 255)
    return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), 1.0)


def over(fg, bg):
    """composite fg (with alpha) onto an opaque bg"""
    a = fg[3]
    return tuple(fg[i] * a + bg[i] * (1 - a) for i in range(3)) + (1.0,)


def lum(c):
    def ch(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    return .2126 * ch(c[0]) + .7152 * ch(c[1]) + .0722 * ch(c[2])


def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + .05) / (lo + .05)


def main():
    themes = parse()
    want = sys.argv[1:] or list(themes)
    worst = {}
    for name in want:
        t = themes[name]
        paper, panel = rgb(t["paper"]), rgb(t["panel"])
        ink = rgb(t["ink"])
        pairs = [("ink on paper", ink, paper, 4.5),
                 ("ink on panel", ink, panel, 4.5)]
        for tier in ("dim-1", "dim-2", "dim-3"):
            a = float(t.get(tier, 1))
            if a < 1:
                faded = (ink[0], ink[1], ink[2], a)
                pairs.append((f"ink @{tier} ({a}) on paper", over(faded, paper), paper, 4.5))
                pairs.append((f"ink @{tier} ({a}) on panel", over(faded, panel), panel, 4.5))
        for fill in ("green", "yellow", "red"):
            if f"on-{fill}" in t:
                pairs.append((f"on-{fill} on {fill}", rgb(t[f"on-{fill}"]), rgb(t[fill]), 4.5))
        for soft in ("green-soft", "yellow-soft", "red-soft"):
            if soft in t:
                pairs.append((f"ink on {soft}", ink, rgb(t[soft]), 4.5))
        if "green-deep" in t:
            pairs.append(("green-deep on panel", rgb(t["green-deep"]), panel, 3.0))
        if "alert" in t:
            pairs.append(("alert on paper", rgb(t["alert"]), paper, 4.5))
        bad = []
        print(f"\n=== {name}")
        for label, fg, bg, need in pairs:
            r = ratio(fg, bg)
            ok = r >= need
            if not ok:
                bad.append((label, r, need))
            print(f"  {'ok  ' if ok else 'FAIL'} {label:<34} {r:5.2f}:1   (need {need})")
        worst[name] = bad
    print("\n---- summary")
    for name, bad in worst.items():
        print(f"  {name:<12} {len(bad)} failing" + ("" if not bad else
              "   worst: " + min(bad, key=lambda x: x[1])[0] + f" {min(b[1] for b in bad):.2f}:1"))
    return 1 if any(worst.values()) else 0


if __name__ == "__main__":
    sys.exit(main())
