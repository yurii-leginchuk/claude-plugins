() => {
  const clean = (t) => (t || '').trim().replace(/\s+/g, ' ');
  const SKIP = 'script,style,noscript,template,svg,iframe,#wpadminbar,.screen-reader-text,.sr-only,[aria-hidden="true"],[class*="cookie"],[id*="cookie"],[id*="CybotCookiebot"],[class*="chat-widget"],[id*="hubspot-messages"]';
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const parseColor = (c) => {
    if (!c) return null;
    let m = c.match(/^rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    m = c.match(/^color\(srgb ([^)]+)\)/);
    if (m) {
      const p = m[1].split(/[\s\/]+/).filter(Boolean).map(Number);
      return { r: Math.round(p[0] * 255), g: Math.round(p[1] * 255), b: Math.round(p[2] * 255), a: p.length > 3 ? p[3] : 1 };
    }
    return { raw: c };
  };
  const over = (top, bottom) => {
    const a = top.a + bottom.a * (1 - top.a);
    if (!a) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (k) => Math.round((top[k] * top.a + bottom[k] * bottom.a * (1 - top.a)) / a);
    return { r: mix('r'), g: mix('g'), b: mix('b'), a: +a.toFixed(3) };
  };
  const effectiveBg = (el) => {
    const layers = [];
    let uncertain = false;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.backgroundImage && s.backgroundImage !== 'none') uncertain = true;
      const c = parseColor(s.backgroundColor);
      if (c && c.a > 0 && c.r !== undefined) { layers.push(c); if (c.a >= 1) break; }
    }
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
    return { color: acc, uncertain };
  };
  const selectorOf = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 3; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(p + '#' + e.id); break; }
      const cls = [...e.classList].filter(c => !/^(elementor-element-[0-9a-f]+|e-con|e-flex|e-child|e-parent)$/.test(c)).slice(0, 2);
      if (cls.length) p += '.' + cls.join('.');
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  const roleOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return tag;
    if (tag === 'button' || el.getAttribute('role') === 'button' || (tag === 'a' && /btn|button/i.test(el.className))) return 'button';
    if (el.closest('.elementor-button, .wp-block-button, [class*="btn"], button')) return 'button';
    if (['input', 'textarea', 'select'].includes(tag)) return 'input';
    if (tag === 'label') return 'label';
    if (el.closest('a')) return 'link';
    return 'text';
  };
  const regionOf = (el) => {
    const r = el.closest('header, footer, nav, aside, [class*="header"], [class*="footer"]');
    if (!r) return 'main';
    const t = r.tagName.toLowerCase();
    if (t === 'header' || /header/i.test(r.className)) return 'header';
    if (t === 'footer' || /footer/i.test(r.className)) return 'footer';
    return t;
  };
  const visible = (el, s, rect) => rect.width > 1 && rect.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05;
  const ownText = (el) => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ');
  const inlineOnly = (el) => [...el.children].every(c => /^inline/.test(getComputedStyle(c).display) || c.tagName === 'BR');
  const textOf = (el) => {
    const own = clean(ownText(el));
    return own && inlineOnly(el) ? clean(el.innerText) : own;
  };

  const out = [];
  const all = document.body.querySelectorAll('*');
  for (const el of all) {
    if (out.length >= 2500) break;
    if (el.closest(SKIP)) continue;
    const tag = el.tagName.toLowerCase();
    const isField = ['input', 'textarea', 'select', 'button'].includes(tag) && el.type !== 'hidden';
    const text = textOf(el) ||(isField ? clean(el.value || el.placeholder || el.innerText) : '');
    if (!text && !isField) continue;
    const s = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (!visible(el, s, rect)) continue;
    const bg = effectiveBg(el);
    const lh = s.lineHeight === 'normal' ? 'normal' : num(s.lineHeight);
    const role = roleOf(el);
    const item = {
      tag, role, region: regionOf(el), selector: selectorOf(el), text: text.slice(0, 80),
      rect: { x: Math.round(rect.left + scrollX), y: Math.round(rect.top + scrollY), w: Math.round(rect.width), h: Math.round(rect.height) },
      fontStack: s.fontFamily,
      family: s.fontFamily.split(',')[0].trim().replace(/^['"]|['"]$/g, ''),
      weight: num(s.fontWeight), size: num(s.fontSize), lineHeight: lh,
      letterSpacing: s.letterSpacing === 'normal' ? 0 : num(s.letterSpacing),
      textTransform: s.textTransform, fontStyle: s.fontStyle,
      decoration: s.textDecorationLine,
      color: parseColor(s.color), opacity: +s.opacity,
      bg: parseColor(s.backgroundColor), effBg: bg.color, bgUncertain: bg.uncertain,
    };
    if (role === 'button' || role === 'input') {
      item.border = { color: parseColor(s.borderTopColor), width: num(s.borderTopWidth), radius: s.borderTopLeftRadius };
      item.padding = [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].join(' ');
    }
    out.push(item);
  }

  const fonts = [...document.fonts].map(f => ({ family: f.family.replace(/['"]/g, ''), weight: f.weight, style: f.style, status: f.status }));
  const vars = {};
  try {
    const rs = getComputedStyle(document.documentElement);
    for (const p of rs) {
      if (!p.startsWith('--')) continue;
      const v = rs.getPropertyValue(p).trim();
      if (/^(#|rgb|hsl)/i.test(v) || /font-family|font-weight|font-size/i.test(p)) vars[p] = v;
    }
  } catch (e) {}

  return JSON.stringify({
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    docHeight: document.documentElement.scrollHeight,
    elements: out,
    fonts,
    cssVars: vars,
  });
}
