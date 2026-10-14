import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  approvalTask, askText, AskNode, checkAnswer, chooseByRules, completeError, countAsk, follow, getPath, graphFlow, LIMIT, planCall,
  ranOutput, reachableInput, saveAnswer, saveResponse, settle, stepCard, visitOf,
} from '../src/engine/engine';
import { BranchNode, StepNode } from '../src/types';
import { action, newFacts, returnGraph } from './fixtures';

describe('inputs', () => {
  it('checks each format', () => {
    assert.deepEqual(checkAnswer('email', 'it is Me@Shop.COM thanks'), { ok: true, value: 'me@shop.com' });
    assert.deepEqual(checkAnswer('number', 'about 1,250.5 dollars'), { ok: true, value: 1250.5 });
    assert.deepEqual(checkAnswer('phone', '+91 98765-43210'), { ok: true, value: '+919876543210' });
    assert.deepEqual(checkAnswer('phone', '12'), { ok: false });
    assert.deepEqual(checkAnswer('text', '   '), { ok: false });
  });

  it('saves the answer and counts asks up to the limit', () => {
    const f = newFacts();
    const node: AskNode = { id: 'i1', type: 'ask', prompt: [], saveAs: 'orderid', format: 'text' };
    f.asked = { i1: '2026-10-12T00:00:00Z' };
    saveAnswer(f, node, 'ORD-1');
    assert.deepEqual(f.vars, { orderid: 'ORD-1' });
    assert.deepEqual(f.varsBy, { i1: ['orderid'] });
    assert.deepEqual(f.outputs.i1, { orderid: 'ORD-1' });
    assert.equal(f.asked.i1, undefined);
    assert.deepEqual([countAsk(f, 'i1'), countAsk(f, 'i1'), countAsk(f, 'i1'), countAsk(f, 'i1')], [false, false, false, true]);
  });

  it('uses the custom retry text, else the default for the format', () => {
    const node: AskNode = { id: 'i1', type: 'ask', prompt: [{ t: 'text', v: 'Email?' }], saveAs: 'e', format: 'email' };
    assert.equal(askText(node, false, {}), 'Email?');
    assert.match(askText(node, true, {}), /email address/);
    assert.equal(askText({ ...node, retry: 'Try again' }, true, {}), 'Try again');
  });
});

describe('rule conditions', () => {
  const branch = (rules: BranchNode['cases']): BranchNode => ({ id: 'c', type: 'branch', mode: 'rules', cases: rules });

  it('first matching case wins, else catches the rest', () => {
    const b = branch([
      { id: 'big', kind: 'if', condition: [], rules: [{ var: 'amount', op: '>', value: '100' }] },
      { id: 'vip', kind: 'else_if', condition: [], rules: [{ var: 'tier', op: '=', value: 'VIP' }] },
      { id: 'rest', kind: 'else', condition: [] },
    ]);
    assert.equal(chooseByRules(b, { amount: 150 }).case_id, 'big');
    assert.equal(chooseByRules(b, { amount: 20, tier: 'vip' }).case_id, 'vip');
    assert.equal(chooseByRules(b, { amount: 20 }).case_id, 'rest');
  });

  it('compares with another variable (ref)', () => {
    const b = branch([{ id: 'same', kind: 'if', condition: [], rules: [{ var: 'email', op: '=', value: '', ref: 'account_email' }] }]);
    assert.equal(chooseByRules(b, { email: 'A@x.com', account_email: 'a@x.com' }).case_id, 'same');
    assert.equal(chooseByRules(b, { email: 'b@x.com', account_email: 'a@x.com' }).case_id, null);
    assert.match(chooseByRules(b, { email: 'a@x.com', account_email: 'a@x.com' }).reason, /\{\{account_email\}\}/);
  });

  it('supports or, contains, empty and not_empty', () => {
    const b = branch([{ id: 'hit', kind: 'if', condition: [], join: 'or', rules: [
      { var: 'note', op: 'contains', value: 'broken' }, { var: 'photo', op: 'not_empty', value: '' },
    ] }]);
    assert.equal(chooseByRules(b, { note: 'It is BROKEN' }).case_id, 'hit');
    assert.equal(chooseByRules(b, { photo: 'x.png' }).case_id, 'hit');
    assert.equal(chooseByRules(b, { note: 'fine' }).case_id, null);
    const e = branch([{ id: 'none', kind: 'if', condition: [], rules: [{ var: 'x', op: 'empty', value: '' }] }]);
    assert.equal(chooseByRules(e, {}).case_id, 'none');
  });
});

describe('loops (maxVisits and fresh)', () => {
  it('a canvas loop back counts visits, clears answers when fresh, and stops at the limit', () => {
    const flow = graphFlow(returnGraph());
    const f = newFacts();
    f.trail = ['b1', 'i1', 's1', 'c1', 'b3'];
    f.vars = { orderid: 'ORD-1', other: 'ORD-2' };
    f.varsBy = { i1: ['orderid'], i3: ['other'] };
    f.outputs = { i1: { orderid: 'ORD-1' }, s1: { data: [] } };
    const j1 = follow(f, 'i3', flow.next('i3'));
    assert.equal(j1.to, 'i1');
    assert.equal(j1.events[0].type, 'goto_jumped');
    assert.equal(f.visits.e3, 2);
    assert.equal(visitOf(f), 2, 'a loop back is a new visit (fresh idempotency key)');
    assert.equal(f.vars.orderid, undefined, 'fresh loop clears the answer');
    assert.equal(f.outputs.i1, undefined);
    assert.deepEqual(f.previous?.s1, { data: [] });
    assert.deepEqual(f.trail, ['b1'], 'the trail is cut back to before the loop target');
    f.trail = ['i1', 's1', 'c1', 'b3'];
    const j2 = follow(f, 'i3', flow.next('i3'));
    assert.equal(j2.to, LIMIT);
    assert.equal(j2.events[0].type, 'goto_limit');
  });

  it('a loop without fresh keeps earlier answers', () => {
    const g = returnGraph();
    g.edges[2].fresh = false;
    const flow = graphFlow(g);
    const f = newFacts();
    f.trail = ['i1', 's1', 'c1', 'b3'];
    f.vars = { orderid: 'ORD-1' };
    f.varsBy = { i1: ['orderid'] };
    follow(f, 'i3', flow.next('i3'));
    assert.equal(f.vars.orderid, 'ORD-1');
  });

});

describe('save response', () => {
  it('reads paths and saves mapped fields', () => {
    const out = { data: [{ status: 'Delivered', items: ['a', 'b'] }] };
    assert.equal(getPath(out, 'data[0].status'), 'Delivered');
    assert.equal(getPath(out, 'data.0.items.length'), 2);
    assert.deepEqual(getPath(out, '$'), out, '$ is the whole response');
    const f = newFacts();
    const r = saveResponse(f, 's1', [{ path: 'data[0].status', var: 'order_status' }, { path: 'data[0].missing', var: 'x' }], out);
    assert.deepEqual(r, { saved: { order_status: 'Delivered' }, missing: ['data[0].missing'] });
    assert.deepEqual(f.vars, { order_status: 'Delivered' });
    assert.deepEqual(f.varsBy, { s1: ['order_status'] });
  });
});

describe('actions and approvals', () => {
  const step: StepNode = { id: 's', type: 'step', content: [{ t: 'text', v: 'Refund with ' }, { t: 'action', key: 'refund_order' }] };

  it('rejects actions the step does not allow, disabled actions and bad args', () => {
    assert.deepEqual(planCall(step, 'delete_all', action({ key: 'delete_all' }), {}), { ok: false, error: 'delete_all is not allowed in this step' });
    assert.deepEqual(planCall(step, 'refund_order', action({ enabled: false }), { order_id: '1' }), { ok: false, error: 'refund_order is disabled' });
    assert.deepEqual(planCall(step, 'refund_order', action({}), {}), { ok: false, error: 'missing order_id' });
    assert.deepEqual(planCall(step, 'refund_order', action({}), { order_id: '1', amount: '1.5' }), { ok: false, error: 'amount must be an integer' });
  });

  it('sends actions that need approval to the team first', () => {
    const p = planCall(step, 'refund_order', action({ requires_approval: true }), { order_id: 'ORD-1', amount: '7999' });
    assert.deepEqual(p, { ok: true, kind: 'approval', args: { order_id: 'ORD-1', amount: 7999 } });
    assert.deepEqual(approvalTask(action({})), { summary: 'Refund order' });
    assert.equal((planCall(step, 'refund_order', action({}), { order_id: '1' }) as any).kind, 'run');
  });

  it('knows builtin escalate and evidence approval', () => {
    const s: StepNode = { id: 's', type: 'step', content: [{ t: 'action', key: 'escalate_to_human' }, { t: 'action', key: 'request_approval' }] };
    const esc = action({ key: 'escalate_to_human', input_schema: { type: 'object', properties: { reason: { type: 'string' } } } });
    const ev = action({ key: 'request_approval', input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } });
    assert.equal((planCall(s, 'escalate_to_human', esc, { reason: 'angry' }) as any).kind, 'escalate');
    assert.equal((planCall(s, 'request_approval', ev, { summary: 'photo' }) as any).kind, 'evidence');
  });

  it('never runs an action twice, and pending approval does not count as ran', () => {
    const f = newFacts();
    f.outputs.s = { approval_task_id: 't1' };
    assert.equal(ranOutput(f, 's'), undefined);
    assert.equal(completeError(step, f), null, 'approval requested counts as called');
    f.outputs.s = { refunded: true };
    assert.deepEqual(ranOutput(f, 's'), { refunded: true });
    assert.equal(completeError(step, newFacts()), 'step completed without calling its action');
  });
});

describe('agent runs', () => {
  it('nothing runs on its own: a move waits at the next block, or ends the run when none is left', () => {
    assert.deepEqual(settle('b1'), { at: 'b1', events: [] });
    assert.deepEqual(settle(null).end, { status: 'completed', reason: 'completed' });
  });

  it('only allows answering a later input with nothing but bubbles and inputs in between', () => {
    const flow = graphFlow(returnGraph());
    assert.equal(reachableInput(flow, 'b3', 'i3'), true);
    assert.equal(reachableInput(flow, 'i1', 'i2'), false, 'an AI step and a condition come first');
  });

  it('builds a step card for each node type the agent handles', () => {
    const flow = graphFlow(returnGraph());
    assert.deepEqual(stepCard(flow, 's1', {}), { id: 's1', type: 'ai_step', text: 'Look up the order with `lookup_orders`', tools: ['lookup_orders'] });
    assert.deepEqual(stepCard(flow, 'i1', {})?.collects, { name: 'orderid', format: 'text' });
    assert.deepEqual(stepCard(flow, 'b1', { 'customer.name': 'Dev' }), { id: 'b1', type: 'bubble', text: 'Hi Dev', tools: [] });
    assert.deepEqual(stepCard(flow, 'c1', {})?.cases?.[0], { id: 'k1', kind: 'if', when: 'order_status = "delivered"' });
    assert.equal(stepCard(flow, 'c1', {})?.type, 'rules_condition');
  });
});
