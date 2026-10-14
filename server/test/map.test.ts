import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMap } from '../src/engine/map';
import { returnGraph } from './fixtures';

describe('workflow map', () => {
  const map = buildMap(returnGraph(), { name: 'Item return', whenToUse: 'The customer wants to return an item.' }, new Set(['create_return']));

  it('numbers groups in run order and puts unreachable ones last', () => {
    assert.deepEqual(map.groups.map((g) => [g.ref, g.title, g.reachable]), [
      ['1', 'Find the order', true], ['2', 'Return', true], ['3', 'Not delivered', true], ['4', 'Orphan', false],
    ]);
    assert.equal(map.start, '1');
  });

  it('lists what each step collects, its tools and saves', () => {
    const [b1, i1, s1] = map.groups[0].items;
    assert.equal(b1.type, 'bubble');
    assert.deepEqual(i1.collects, { name: 'orderid', format: 'text' });
    assert.deepEqual(s1.tools, [{ key: 'lookup_orders', needsApproval: false }]);
    assert.deepEqual(s1.save, [{ path: 'data[0].status', var: 'order_status' }]);
    assert.deepEqual(map.groups[1].items[1].tools, [{ key: 'create_return', needsApproval: true }]);
  });

  it('shows where each branch goes, and the loop', () => {
    const c1 = map.groups[0].items[3];
    assert.deepEqual(c1.cases, [
      { id: 'k1', kind: 'if', when: 'order_status = "delivered"', goes: '2' },
      { id: 'k2', kind: 'else', when: 'otherwise', goes: '3' },
    ]);
    assert.equal(map.groups[2].then, '1.2 (loop)');
    assert.equal(map.groups[1].then, 'end');
    assert.deepEqual(map.loops, [{ from: '3', to: '1.2', maxVisits: 2, fresh: true }]);
  });

  it('renders prompt text', () => {
    assert.equal(map.text, [
      'WORKFLOW: Item return',
      'When to use: The customer wants to return an item.',
      '',
      'WORKFLOW MAP',
      '1 Find the order',
      '  1.1 [b1] bubble "Hi {{customer.name}}"',
      '  1.2 [i1] input saves orderid (text) "Your order ID?"',
      '  1.3 [s1] ai_step "Look up the order with `lookup_orders`"  tools: lookup_orders  save: data[0].status → order_status',
      '  1.4 [c1] condition (rules) if order_status = "delivered" [k1] → 2 · else [k2] → 3',
      '  then → end',
      '2 Return',
      '  2.1 [i2] input saves reason (text) "Why are you returning it?"',
      '  2.2 [s2] ai_step "Create the return with `create_return`"  tools: create_return (needs approval)',
      '  2.3 [b2] bubble "Return booked for {{orderid}}"',
      '  then → end',
      '3 Not delivered',
      '  3.1 [b3] bubble "Returns open once it is delivered."',
      '  3.2 [i3] input saves other (text) "Another order?"',
      '  then → 1.2 (loop)',
      '4 Orphan (not reachable)',
      '  4.1 [b4] bubble "never reached"',
      '  then → end',
      'loop 3 → 1.2: max 2 visits, ask again',
    ].join('\n'));
  });
});
