#!/usr/bin/env python3
"""Flatten a Figma REST /v1/files/:key/nodes response into figma-styles.json.

Usage: figma_styles.py <nodes.json> <node-id> <out.json>
"""
import json
import sys
from collections import Counter, defaultdict


def rgba(color, opacity=1.0):
    return {
        "r": round(color["r"] * 255),
        "g": round(color["g"] * 255),
        "b": round(color["b"] * 255),
        "a": round(color.get("a", 1) * opacity, 3),
    }


def hexof(c):
    return "#{:02X}{:02X}{:02X}".format(c["r"], c["g"], c["b"])


def solid(fills, opacity):
    for f in fills or []:
        if f.get("visible", True) is False:
            continue
        if f.get("type") == "SOLID":
            return rgba(f["color"], f.get("opacity", 1) * opacity), "solid"
        if f.get("type", "").startswith("GRADIENT"):
            stops = f.get("gradientStops") or []
            if stops:
                return rgba(stops[0]["color"], f.get("opacity", 1) * opacity), "gradient"
        if f.get("type") == "IMAGE":
            return None, "image"
    return None, None


def text_style(base, override, opacity, style_names, node_styles):
    s = dict(base)
    s.update({k: v for k, v in (override or {}).items() if k != "fills"})
    fills = (override or {}).get("fills")
    color, kind = solid(fills, opacity) if fills else (None, None)
    auto_lh = s.get("lineHeightUnit") == "INTRINSIC_%"
    return {
        "fontFamily": s.get("fontFamily"),
        "fontPostScriptName": s.get("fontPostScriptName"),
        "fontWeight": s.get("fontWeight"),
        "fontSize": s.get("fontSize"),
        "lineHeightPx": None if auto_lh else s.get("lineHeightPx"),
        "letterSpacing": s.get("letterSpacing", 0),
        "textCase": s.get("textCase", "ORIGINAL"),
        "italic": bool(s.get("italic")),
        "textDecoration": s.get("textDecoration", "NONE"),
        "color": color,
        "colorKind": kind,
        "textStyleName": style_names.get(node_styles.get("text")),
        "fillStyleName": style_names.get(node_styles.get("fill") or node_styles.get("fills")),
    }


def main():
    src, node_id, dst = sys.argv[1], sys.argv[2].replace("-", ":"), sys.argv[3]
    data = json.load(open(src))
    entry = data["nodes"].get(node_id) or next(iter(data["nodes"].values()))
    root = entry["document"]
    style_names = {k: v.get("name") for k, v in (entry.get("styles") or {}).items()}
    fb = root.get("absoluteBoundingBox") or {"x": 0, "y": 0, "width": 0, "height": 0}

    texts, fills = [], []

    def box(n):
        b = n.get("absoluteBoundingBox") or {}
        return {
            "x": round(b.get("x", 0) - fb["x"]),
            "y": round(b.get("y", 0) - fb["y"]),
            "w": round(b.get("width", 0)),
            "h": round(b.get("height", 0)),
        }

    def walk(n, opacity, path):
        if n.get("visible", True) is False:
            return
        opacity *= n.get("opacity", 1)
        path = path + [n.get("name", "")]
        node_styles = n.get("styles") or {}
        if n.get("type") == "TEXT":
            base = n.get("style") or {}
            node_color, node_kind = solid(n.get("fills"), opacity)
            chars = n.get("characters", "")
            overrides = n.get("characterStyleOverrides") or []
            table = n.get("styleOverrideTable") or {}
            runs, start = [], 0
            ids = [overrides[i] if i < len(overrides) else 0 for i in range(len(chars))]
            for i in range(1, len(chars) + 1):
                if i == len(chars) or ids[i] != ids[start]:
                    ov = table.get(str(ids[start])) if ids[start] else None
                    st = text_style(base, ov, opacity, style_names, node_styles)
                    if st["color"] is None:
                        st["color"], st["colorKind"] = node_color, node_kind
                    st["chars"] = chars[start:i]
                    runs.append(st)
                    start = i
            if not runs:
                st = text_style(base, None, opacity, style_names, node_styles)
                st["color"], st["colorKind"], st["chars"] = node_color, node_kind, ""
                runs.append(st)
            texts.append({
                "id": n["id"], "name": n.get("name"), "path": " / ".join(path[1:-1])[-120:],
                "characters": chars, **box(n), "runs": runs,
            })
            return
        color, kind = solid(n.get("fills"), opacity)
        if color and kind in ("solid", "gradient") and n.get("type") != "DOCUMENT":
            stroke, _ = solid(n.get("strokes"), opacity)
            fills.append({
                "id": n["id"], "name": n.get("name"), "type": n.get("type"), **box(n),
                "color": color, "colorKind": kind,
                "styleName": style_names.get(node_styles.get("fill") or node_styles.get("fills")),
                "cornerRadius": n.get("cornerRadius"),
                "stroke": stroke, "strokeWeight": n.get("strokeWeight") if stroke else None,
            })
        for c in n.get("children") or []:
            walk(c, opacity, path)

    walk(root, 1.0, [])

    palette = defaultdict(lambda: {"count": 0, "names": set(), "uses": set()})
    for t in texts:
        for r in t["runs"]:
            if r["color"]:
                p = palette[hexof(r["color"])]
                p["count"] += 1
                p["uses"].add("text")
                if r["fillStyleName"]:
                    p["names"].add(r["fillStyleName"])
    for f in fills:
        p = palette[hexof(f["color"])]
        p["count"] += 1
        p["uses"].add("fill")
        if f["styleName"]:
            p["names"].add(f["styleName"])

    scale = Counter()
    scale_names = defaultdict(set)
    for t in texts:
        for r in t["runs"]:
            key = (r["fontFamily"], r["fontWeight"], r["fontSize"], r["lineHeightPx"] and round(r["lineHeightPx"], 1), round(r["letterSpacing"] or 0, 2), r["textCase"])
            scale[key] += 1
            if r["textStyleName"]:
                scale_names[key].add(r["textStyleName"])

    out = {
        "source": "figma-rest",
        "frame": {"id": root.get("id"), "name": root.get("name"), "width": round(fb["width"]), "height": round(fb["height"])},
        "texts": texts,
        "fills": fills,
        "palette": sorted(
            [{"hex": h, "count": v["count"], "names": sorted(v["names"]), "uses": sorted(v["uses"])} for h, v in palette.items()],
            key=lambda x: -x["count"],
        ),
        "typeScale": [
            {"family": k[0], "weight": k[1], "size": k[2], "lineHeight": k[3], "letterSpacing": k[4], "textCase": k[5], "count": c, "names": sorted(scale_names[k])}
            for k, c in scale.most_common()
        ],
    }
    json.dump(out, open(dst, "w"), ensure_ascii=False, indent=1)
    print(f"frame {out['frame']['name']} {out['frame']['width']}x{out['frame']['height']}: "
          f"{len(texts)} text nodes, {len(fills)} fills, {len(out['palette'])} colours, {len(out['typeScale'])} text styles")


if __name__ == "__main__":
    main()
