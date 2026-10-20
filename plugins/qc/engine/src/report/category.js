// Who fixes a defect:
//   dev  — a developer fixes it on the site without another team;
//   seo  — it most likely needs input from the SEO department (titles,
//          descriptions, headings, schema, indexing, redirects, site structure);
//   copy — it most likely needs input from the copy team (wording, claims,
//          placeholders, contradictions, typos).
// This is the engine's default per rule; Claude confirms or changes it per
// defect in the review (`category` on an item or a manual defect).
export const CATEGORIES = ['dev', 'seo', 'copy']

const BY_RULE = {
  seo: ['I1', 'I4', 'I5', 'I6', 'I7', 'I8', 'I10', 'I18', 'I20', 'I21', 'S1', 'E12', 'E14', 'H9', 'H11'],
  copy: ['H1', 'H3', 'H5', 'H6', 'H8', 'H12', 'H14', 'H16', 'E17'],
}

export function categoryOf(f) {
  if (f.category && CATEGORIES.includes(f.category)) return f.category
  if (f.rule === 'H17') return /^og:site_name/i.test(String(f.found || '')) ? 'seo' : 'copy'
  for (const [cat, rules] of Object.entries(BY_RULE)) if (rules.includes(f.rule)) return cat
  return 'dev'
}
