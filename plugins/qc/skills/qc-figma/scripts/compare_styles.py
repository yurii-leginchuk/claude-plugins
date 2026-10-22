#!/usr/bin/env python3
"""Compare page computed styles against Figma node properties.

Usage: compare_styles.py <figma-styles.json> <page-styles.json> <out.json> [--label desktop|mobile]
Thresholds and severities: references/style-checks.md.
"""
import json
import math
import re
import sys
from collections import defaultdict
from difflib import SequenceMatcher

GENERIC = {"serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "-apple-system",
           "blinkmacsystemfont", "ui-sans-serif", "ui-serif", "ui-monospace"}
WEB_SAFE = {"arial", "helvetica", "helveticaneue", "georgia", "timesnewroman", "times", "verdana", "tahoma",
            "trebuchetms", "couriernew", "segoeui", "roboto"}
SEV_RANK = {"Critical": 3, "Major": 2, "Minor": 1, "Note": 0}


def norm_text(t):
    t = (t or "").lower().replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    t = re.sub(r"[–—]", "-", t)
    t = re.sub(r"[^\w\s'&$%+-]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def norm_family(f):
    return re.sub(r"[\s_-]+", "", (f or "").lower().strip("'\""))


def srgb_to_lab(c):
    def lin(v):
        v /= 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = lin(c["r"]), lin(c["g"]), lin(c["b"])
    x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047
    y = r * 0.2126 + g * 0.7152 + b * 0.0722
    z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883
    f = lambda t: t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def de2000(c1, c2):
    L1, a1, b1 = srgb_to_lab(c1)
    L2, a2, b2 = srgb_to_lab(c2)
    C1, C2 = math.hypot(a1, b1), math.hypot(a2, b2)
    Cb = (C1 + C2) / 2
    G = 0.5 * (1 - math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
    a1p, a2p = a1 * (1 + G), a2 * (1 + G)
    C1p, C2p = math.hypot(a1p, b1), math.hypot(a2p, b2)
    h1p = math.degrees(math.atan2(b1, a1p)) % 360
    h2p = math.degrees(math.atan2(b2, a2p)) % 360
    dLp, dCp = L2 - L1, C2p - C1p
    dhp = 0 if C1p * C2p == 0 else (h2p - h1p if abs(h2p - h1p) <= 180 else h2p - h1p - 360 if h2p > h1p else h2p - h1p + 360)
    dHp = 2 * math.sqrt(C1p * C2p) * math.sin(math.radians(dhp / 2))
    Lbp, Cbp = (L1 + L2) / 2, (C1p + C2p) / 2
    if C1p * C2p == 0:
        hbp = h1p + h2p
    elif abs(h1p - h2p) <= 180:
        hbp = (h1p + h2p) / 2
    else:
        hbp = (h1p + h2p + 360) / 2 if h1p + h2p < 360 else (h1p + h2p - 360) / 2
    T = (1 - 0.17 * math.cos(math.radians(hbp - 30)) + 0.24 * math.cos(math.radians(2 * hbp))
         + 0.32 * math.cos(math.radians(3 * hbp + 6)) - 0.20 * math.cos(math.radians(4 * hbp - 63)))
    dtheta = 30 * math.exp(-(((hbp - 275) / 25) ** 2))
    Rc = 2 * math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7))
    Sl = 1 + 0.015 * (Lbp - 50) ** 2 / math.sqrt(20 + (Lbp - 50) ** 2)
    Sc, Sh = 1 + 0.045 * Cbp, 1 + 0.015 * Cbp * T
    Rt = -math.sin(math.radians(2 * dtheta)) * Rc
    return math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))


def over(top, bottom):
    a = top.get("a", 1)
    return {k: round(top[k] * a + bottom[k] * (1 - a)) for k in "rgb"} | {"a": 1}


def hexof(c):
    return "#{:02X}{:02X}{:02X}".format(c["r"], c["g"], c["b"]) + ("" if c.get("a", 1) >= 0.995 else f" @{c['a']:.2f}")


def from_hex(h):
    h = h.lstrip("#")[:6]
    return {"r": int(h[0:2], 16), "g": int(h[2:4], 16), "b": int(h[4:6], 16), "a": 1}


def color_sev(de):
    return None if de <= 2.3 else "Minor" if de <= 5 else "Major"


def size_sev(d, base, role):
    if abs(d) <= 1:
        return None
    if role in ("h1", "h2", "button") and abs(d) > 2:
        return "Major"
    return "Minor" if abs(d) <= 3 and abs(d) <= 0.1 * base else "Major"


def weight_sev(d):
    return None if d == 0 else "Minor" if abs(d) <= 100 else "Major"


def case_of(text, transform):
    if transform == "uppercase" or (text.upper() == text and text.lower() != text):
        return "UPPER"
    if transform == "lowercase":
        return "LOWER"
    if transform == "capitalize":
        return "TITLE"
    return "ORIGINAL"


def face_covers(face, weight):
    parts = [float(p) for p in str(face["weight"]).replace("normal", "400").replace("bold", "700").split() if re.match(r"^[\d.]+$", p)]
    if not parts:
        return False
    lo, hi = (parts[0], parts[-1])
    return lo <= weight <= hi


def main():
    args = sys.argv[1:]
    label = "desktop"
    if "--label" in args:
        i = args.index("--label")
        label = args[i + 1]
        del args[i:i + 2]
    fig = json.load(open(args[0]))
    page = json.load(open(args[1]))
    dst = args[2]

    frame = fig["frame"]
    doc_h = page.get("docHeight") or 1
    els = page["elements"]
    texts = [t for t in fig["texts"] if norm_text(t["characters"])]
    for t in texts:
        t["_n"] = norm_text(t["characters"])
        t["_yn"] = (t["y"] + t["h"] / 2) / max(frame["height"], 1)

    findings = defaultdict(lambda: {"count": 0, "examples": [], "severity": "Note"})
    pairs = []

    def add(kind, prop, expected, actual, sev, example, detail=""):
        if not sev:
            return
        key = (kind, prop, str(expected), str(actual))
        f = findings[key]
        f.update(kind=kind, prop=prop, expected=expected, actual=actual, detail=detail)
        f["count"] += 1
        if SEV_RANK[sev] > SEV_RANK[f["severity"]]:
            f["severity"] = sev
        if len(f["examples"]) < 6:
            f["examples"].append(example)

    def match(el):
        n = norm_text(el["text"])
        if len(n) < 2:
            return None, None
        best = None
        for t in texts:
            if len(n) < 12 or len(t["_n"]) < 12:
                ok = n == t["_n"]
            elif n == t["_n"]:
                ok = True
            elif len(n) >= 8 and n in t["_n"]:
                ok = True
            else:
                ok = SequenceMatcher(None, n, t["_n"]).quick_ratio() >= 0.88 and SequenceMatcher(None, n, t["_n"]).ratio() >= 0.88
            if not ok:
                continue
            dy = abs(t["_yn"] - (el["rect"]["y"] + el["rect"]["h"] / 2) / doc_h)
            if best is None or dy < best[0]:
                best = (dy, t)
        if not best:
            return None, None
        t = best[1]
        run = next((r for r in t["runs"] if n and n in norm_text(r["chars"])), None)
        run = run or max(t["runs"], key=lambda r: len(r["chars"]))
        return t, run

    def container_fill(t):
        cands = [f for f in fig["fills"]
                 if f["x"] <= t["x"] and f["y"] <= t["y"] and f["x"] + f["w"] >= t["x"] + t["w"] and f["y"] + f["h"] >= t["y"] + t["h"]
                 and f["w"] * f["h"] < frame["width"] * frame["height"] * 0.9]
        return min(cands, key=lambda f: f["w"] * f["h"]) if cands else None

    fig_families = {norm_family(r["fontFamily"]): r["fontFamily"] for t in texts for r in t["runs"] if r["fontFamily"]}
    fig_combos = {(norm_family(s["family"]), s["weight"]) for s in fig["typeScale"]}
    fig_sizes = defaultdict(set)
    for s in fig["typeScale"]:
        fig_sizes[norm_family(s["family"])].add(s["size"])
    palette = [(p["hex"], from_hex(p["hex"]), ", ".join(p.get("names") or [])) for p in fig["palette"]]

    matched = 0
    matched_fig = set()
    for el in els:
        ex = {"selector": el["selector"], "text": el["text"][:60], "region": el["region"], "role": el["role"]}
        t, r = match(el)
        if t:
            matched += 1
            matched_fig.add(t["id"])
            ex["figmaNode"] = f'{t["name"]} ({t["id"]})'
            row = {"page": ex, "figma": {"node": t["id"], "name": t["name"], "textStyle": r.get("textStyleName"), "fillStyle": r.get("fillStyleName")}, "props": {}}

            def prop(name, exp, act, sev):
                row["props"][name] = {"figma": exp, "page": act, "status": sev or "ok"}
                add("pair", name, exp, act, sev, ex)

            if r["fontFamily"]:
                prop("font-family", r["fontFamily"], el["family"],
                     None if norm_family(r["fontFamily"]) == norm_family(el["family"]) else "Major")
            if r["fontWeight"] and el["weight"]:
                prop("font-weight", r["fontWeight"], el["weight"], weight_sev(el["weight"] - r["fontWeight"]))
            if r["fontSize"] and el["size"]:
                prop("font-size", f'{r["fontSize"]:g}px', f'{el["size"]:g}px', size_sev(el["size"] - r["fontSize"], r["fontSize"], el["role"]))
            if r["lineHeightPx"]:
                page_lh = el["size"] * 1.2 if el["lineHeight"] == "normal" else el["lineHeight"]
                if page_lh:
                    d = page_lh - r["lineHeightPx"]
                    sev = None if abs(d) <= 2 else "Minor" if abs(d) <= max(6, 0.25 * r["lineHeightPx"]) else "Major"
                    prop("line-height", f'{r["lineHeightPx"]:.1f}px', "normal" if el["lineHeight"] == "normal" else f"{page_lh:.1f}px", sev)
            ls = r.get("letterSpacing") or 0
            if abs((el["letterSpacing"] or 0) - ls) > 0.3:
                prop("letter-spacing", f"{ls:.2f}px", f'{el["letterSpacing"] or 0:.2f}px', "Minor")
            pc, fc = case_of(el["text"], el["textTransform"]), r.get("textCase") or "ORIGINAL"
            if fc in ("UPPER", "LOWER", "TITLE") or pc == "UPPER":
                fig_case = "UPPER" if fc == "ORIGINAL" and r["chars"].upper() == r["chars"] and r["chars"].lower() != r["chars"] else fc
                if fig_case != pc:
                    prop("text-case", fig_case, pc, "Minor")
            if r.get("italic") != (el["fontStyle"] == "italic"):
                prop("font-style", "italic" if r.get("italic") else "normal", el["fontStyle"], "Minor")
            if r["color"] and el["color"] and "r" in el["color"]:
                bg = el["effBg"]
                fcol, pcol = over(r["color"], bg), over(el["color"], bg)
                de = de2000(fcol, pcol)
                sev = color_sev(de)
                if sev and r.get("colorKind") == "gradient":
                    sev = "Note"
                row["props"]["color"] = {"figma": hexof(r["color"]), "page": hexof(el["color"]), "deltaE": round(de, 1), "status": sev or "ok"}
                add("pair", "color", hexof(r["color"]) + (f' ({r["fillStyleName"]})' if r.get("fillStyleName") else ""),
                    hexof(el["color"]), sev, ex | {"deltaE": round(de, 1)})
            if el["role"] == "button":
                cf = container_fill(t)
                page_bg = el["bg"] if el.get("bg") and el["bg"].get("a", 0) > 0 else el["effBg"]
                if cf and page_bg and "r" in page_bg:
                    de = de2000(over(cf["color"], el["effBg"]), over(page_bg, el["effBg"]))
                    sev = color_sev(de)
                    row["props"]["button-bg"] = {"figma": hexof(cf["color"]), "page": hexof(page_bg), "deltaE": round(de, 1), "status": sev or "ok"}
                    add("pair", "button background", hexof(cf["color"]) + (f' ({cf["styleName"]})' if cf.get("styleName") else ""),
                        hexof(page_bg), sev, ex | {"deltaE": round(de, 1)})
                    if cf.get("cornerRadius") is not None and el.get("border"):
                        pr = float(re.sub(r"[^\d.]", "", el["border"]["radius"] or "0") or 0)
                        if abs(pr - cf["cornerRadius"]) > 2:
                            add("pair", "border-radius", f'{cf["cornerRadius"]:g}px', f"{pr:g}px", "Minor", ex)
                            row["props"]["border-radius"] = {"figma": cf["cornerRadius"], "page": pr, "status": "Minor"}
            pairs.append(row)
            continue

        fam = norm_family(el["family"])
        if fam not in fig_families and fam not in GENERIC:
            add("token", "font-family (not in design)", " / ".join(sorted(fig_families.values())), el["family"], "Major", ex)
        elif fam in fig_families:
            if el["weight"] and (fam, el["weight"]) not in fig_combos:
                ws = [w for f, w in fig_combos if f == fam and w]
                gap = min(abs(el["weight"] - w) for w in ws) if ws else 999
                add("token", "font-weight (not in design)", f"{fig_families[fam]}: " + ", ".join(str(int(w)) for w in sorted(ws)),
                    f'{el["family"]} {el["weight"]:g}', "Minor" if gap <= 100 else "Major", ex)
            if el["size"] and not any(abs(el["size"] - s) <= 1 for s in fig_sizes[fam] if s):
                add("token", "font-size (off scale)", f"{fig_families[fam]}: " + ", ".join(f"{s:g}" for s in sorted(x for x in fig_sizes[fam] if x)),
                    f'{el["size"]:g}px', "Minor", ex)
        if palette and el["color"] and "r" in el["color"]:
            pc = over(el["color"], el["effBg"])
            de, hx, names = min(((de2000(pc, c), hx, nm) for hx, c, nm in palette), key=lambda x: x[0])
            sev = color_sev(de)
            if sev:
                add("token", "text colour (off palette)", f"nearest {hx}" + (f" ({names})" if names else ""),
                    hexof(el["color"]), sev, ex | {"deltaE": round(de, 1)})

    fonts = page.get("fonts") or []
    used = defaultdict(set)
    for el in els:
        if el["weight"]:
            used[el["family"]].add(el["weight"])
    for fam, weights in used.items():
        if norm_family(fam) in GENERIC:
            continue
        faces = [f for f in fonts if norm_family(f["family"]) == norm_family(fam)]
        ex = {"selector": "document.fonts", "text": fam, "region": "-", "role": "-"}
        if not faces:
            if norm_family(fam) in WEB_SAFE:
                continue
            add("font-load", "font not served", f"@font-face for {fam}", "none — renders from a locally installed copy or the fallback", "Major", ex)
            continue
        loaded = [f for f in faces if f["status"] == "loaded"]
        if not loaded:
            add("font-load", "font not loaded", fam, "status: " + ", ".join(sorted({f["status"] for f in faces})), "Major", ex)
            continue
        for w in sorted(weights):
            if not any(face_covers(f, w) for f in loaded if f["style"] == "normal"):
                add("font-load", "weight not loaded (synthesised)", f"{fam} {w:g}",
                    "loaded: " + ", ".join(sorted({str(f['weight']) for f in loaded})), "Major", ex | {"text": f"{fam} {w:g}"})

    unmatched_fig = [{"id": t["id"], "name": t["name"], "characters": t["characters"][:60]} for t in texts if t["id"] not in matched_fig]
    out_findings = sorted(
        [v for v in findings.values()],
        key=lambda f: (-SEV_RANK[f["severity"]], -f["count"]),
    )
    counts = defaultdict(int)
    for f in out_findings:
        counts[f["severity"]] += 1
    out = {
        "label": label,
        "figmaFrame": frame,
        "viewport": page.get("viewport"),
        "widthMismatch": abs((page.get("viewport") or {}).get("width", 0) - frame["width"]) > 2,
        "summary": {"pageElements": len(els), "figmaTextNodes": len(texts), "matchedElements": matched,
                    "matchedFigmaNodes": len(matched_fig), "findingsBySeverity": dict(counts)},
        "findings": out_findings,
        "pairs": pairs,
        "unmatchedFigma": unmatched_fig,
        "figmaPalette": fig["palette"],
        "figmaTypeScale": fig["typeScale"],
    }
    json.dump(out, open(dst, "w"), ensure_ascii=False, indent=1)
    s = out["summary"]
    print(f"[{label}] {s['matchedElements']}/{s['pageElements']} page elements matched to {s['matchedFigmaNodes']}/{s['figmaTextNodes']} Figma text nodes; "
          f"findings: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items(), key=lambda x: -SEV_RANK[x[0]])))
    if out["widthMismatch"]:
        print(f"WARNING: viewport {page['viewport']['width']}px != Figma frame {frame['width']}px — fluid sizes are not comparable")


if __name__ == "__main__":
    main()
