import { ActionRow, Facts, WorkflowGraph } from '../src/types';

const t = (v: string) => ({ t: 'text' as const, v });

// "Item return" canvas: find the order, then return it or loop back to ask for another order (max 2 visits, ask again).
export const returnGraph = (): WorkflowGraph => ({
  start: 'g1',
  variables: ['orderid', 'order_status', 'reason', 'other'],
  groups: [
    { id: 'g1', title: 'Find the order', x: 0, y: 0, items: [
      { id: 'b1', type: 'bubble', content: [t('Hi '), { t: 'var', key: 'customer.name' }] },
      { id: 'i1', type: 'input', prompt: [t('Your order ID?')], saveAs: 'orderid', format: 'text' },
      { id: 's1', type: 'step', content: [t('Look up the order with '), { t: 'action', key: 'lookup_orders' }], save: [{ path: 'data[0].status', var: 'order_status' }] },
      { id: 'c1', type: 'condition', mode: 'rules', cases: [
        { id: 'k1', kind: 'if', condition: [], rules: [{ var: 'order_status', op: '=', value: 'delivered' }] },
        { id: 'k2', kind: 'else', condition: [] },
      ] },
    ] },
    { id: 'g2', title: 'Return', x: 0, y: 0, items: [
      { id: 'i2', type: 'input', prompt: [t('Why are you returning it?')], saveAs: 'reason', format: 'text' },
      { id: 's2', type: 'step', content: [t('Create the return with '), { t: 'action', key: 'create_return' }] },
      { id: 'b2', type: 'bubble', content: [t('Return booked for '), { t: 'var', key: 'orderid' }] },
    ] },
    { id: 'g3', title: 'Not delivered', x: 0, y: 0, items: [
      { id: 'b3', type: 'bubble', content: [t('Returns open once it is delivered.')] },
      { id: 'i3', type: 'input', prompt: [t('Another order?')], saveAs: 'other', format: 'text' },
    ] },
    { id: 'g4', title: 'Orphan', x: 0, y: 0, items: [{ id: 'b4', type: 'bubble', content: [t('never reached')] }] },
  ],
  edges: [
    { id: 'e1', from: { groupId: 'g1', itemId: 'c1', port: 'k1' }, to: { groupId: 'g2' } },
    { id: 'e2', from: { groupId: 'g1', itemId: 'c1', port: 'k2' }, to: { groupId: 'g3' } },
    { id: 'e3', from: { groupId: 'g3' }, to: { groupId: 'g1', itemId: 'i1' }, maxVisits: 2, fresh: true },
  ],
});

export const newFacts = (): Facts => ({ collected: {}, outputs: {}, cases: {}, attempts: {}, visits: {} });

export const action = (o: Partial<ActionRow>): ActionRow => ({
  key: 'refund_order', name: 'Refund order', description: '', builtin: false,
  input_schema: { type: 'object', properties: { order_id: { type: 'string' }, amount: { type: 'integer' } }, required: ['order_id'] },
  requires_approval: false, enabled: true, source: 'viasocket_flow', via_flow_id: null, via_flow_url: null, details_edited: false, ...o,
});
