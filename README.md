# claude-plugins

Claude Code plugin marketplace by Yurii Leginchuk.

## Installation

Add the marketplace, then install a plugin:

```
/plugin marketplace add yurii-leginchuk/claude-plugins
/plugin install qc@leginchuk-plugins
```

## Plugins

### qc — WordPress site QC

QC engine for WordPress + Elementor + Gravity Forms sites. A deterministic Node.js engine does all
the checking; Claude runs its CLI and presents results faithfully.

| Command | What it does |
|---|---|
| `/qc-site <url>` | Static audit of a whole site: crawl, broken links, meta, headings, forms, alt text, phone/email formats, dev artifacts. Publishes a rule-grouped HTML report. Accepts a site URL or a Google Sheets strategy link. |
| `/qc-browse <host>` | Browser pass on top of an existing audit: horizontal scroll, overflow, overlapping elements, hover/focus, transitions, contrast, console errors, broken images — with per-breakpoint screenshots. Resumable; findings merge into every subsequent report. |
| `/qc-cache` | Inspect or clear cached crawl snapshots (`~/.qc-cache`). |

**Requirements:**

- Node.js 20+
- Engine dependencies install automatically on first run (`npm install` in the plugin's `engine/` directory)
- `/qc-browse` needs a Playwright Chromium: `npx playwright install chromium` (one-time)

## License

MIT
