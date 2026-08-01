import { allBrowserRules } from '../rules/browser-index.js'
import { helpers } from '../rules/browser/_helpers.js'

// Serialise helpers + every rule's check into one script that defines
// window.__qc.run(ctx). Rules are serialised by source, so a check that closes
// over module scope will throw the moment it runs -- Task 1's contract test
// catches that before it can reach a real site.
function serialiseHelpers(obj) {
  const entries = Object.entries(obj).map(([k, v]) => {
    // ES2015 method shorthand's toString() retains the method name, e.g.
    // "selector(el) { ... }" -- invalid as an object-literal value on its
    // own. Rewrite the leading `name(` to `function (` so it becomes a
    // function expression; `this` still binds correctly since these are
    // always called as helpers.<name>(...).
    const src = v.toString().replace(/^[A-Za-z0-9_$]+\s*\(/, 'function (')
    return `${k}: ${src}`
  })
  return `{ ${entries.join(',\n')} }`
}

export async function buildBundle() {
  const rules = await allBrowserRules()
  const parts = rules.map(r => `  { id: ${JSON.stringify(r.id)}, check: ${r.check.toString()} }`)
  return `
(function () {
  var helpers = ${serialiseHelpers(helpers)};
  var rules = [
${parts.join(',\n')}
  ];
  window.__qc = {
    run: function (ctx) {
      var withHelpers = { url: ctx.url, breakpoint: ctx.breakpoint, helpers: helpers };
      var out = [];
      for (var i = 0; i < rules.length; i++) {
        try {
          var got = rules[i].check(withHelpers) || [];
          for (var j = 0; j < got.length; j++) out.push(got[j]);
        } catch (e) {
          // A crashing rule must not lose the other rules' findings.
          out.push({
            rule: rules[i].id, title: 'Правило упало', severity: 'note',
            confidence: 'high', engine: 'browser', page: ctx.url,
            breakpoint: ctx.breakpoint, selector: null,
            found: 'rule crashed: ' + (e && e.message), expected: null,
          });
        }
      }
      return out;
    }
  };
})();
`
}
