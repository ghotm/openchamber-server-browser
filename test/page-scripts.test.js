import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSelectScript } from '../src/page-scripts.js';

test('builds a select script for exactly one criterion', () => {
  const byLabel = buildSelectScript({ selector: '#native', label: 'Two' });
  assert.match(byLabel, /var criterion = "label"/);
  assert.match(byLabel, /var wanted = "Two"/);
  assert.match(byLabel, /getAttribute\('label'\)/);
  assert.doesNotMatch(byLabel, /option\.label/);

  const byValue = buildSelectScript({ selector: '#native', value: 'Two' });
  assert.match(byValue, /var criterion = "value"/);
  assert.match(byValue, /var wanted = "Two"/);

  for (const parameters of [
    { selector: '#native' },
    { selector: '#native', label: 'One', value: 'One' },
  ]) {
    const script = buildSelectScript(parameters);
    assert.match(script, /var criterion = ""/);
    assert.match(script, /browser\.select requires exactly one of label or value/);
  }
});
