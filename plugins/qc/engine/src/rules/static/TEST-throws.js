// Stub rule for testing error handling in runStaticRules
export default {
  id: 'TEST-throws',
  title: 'Test Rule That Throws',
  severity: 'major',
  engine: 'static',
  check(page, _site) {
    throw new Error('intentional test error')
  },
}
