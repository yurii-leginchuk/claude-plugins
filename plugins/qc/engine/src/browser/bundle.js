import { allBrowserRules } from '../rules/browser-index.js'
import { helpers } from '../rules/browser/_helpers.js'

// Serialise helpers + every rule's check into one script that defines
// window.__qc.run(ctx). Rules are serialised by source, so a check that closes
// over module scope will throw the moment it runs -- Task 1's contract test
// catches that before it can reach a real site.
//
// A straight toString() per entry is safe here ONLY because _helpers.js
// deliberately writes every entry as `key: function (...) {...}` rather than
// ES2015 method shorthand -- shorthand's toString() retains the method name
// (e.g. "selector(el) {...}"), which is invalid once spliced back in as an
// object-literal value. See the comment at the top of _helpers.js. Exported
// so tests can assert the serialised form actually parses and behaves.
export function serialiseHelpers(obj) {
  const entries = Object.entries(obj).map(([k, v]) => `${k}: ${v.toString()}`)
  return `{ ${entries.join(',\n')} }`
}

// `extraRules` lets tests inject a rule (e.g. one that throws) without
// dropping a file into src/rules/browser/, which is the production registry
// -- a stub file there would become a live rule on every real crawl.
export async function buildBundle({ extraRules = [] } = {}) {
  const rules = [...(await allBrowserRules()), ...extraRules]
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
            rule: rules[i].id, title: 'Rule crashed', severity: 'note',
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
