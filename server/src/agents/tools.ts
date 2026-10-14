// The wf_* tools as Mastra tools. The run id comes from the request context, never from the model.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { wfCallAction, wfChooseCase, wfCompleteStep, wfHandoff, wfSaveInput, wfSwitchWorkflow } from './wf-tools';

// Agent turns keep the run id in the shared turn (it changes on start/switch); /dev passes runId directly.
const runIdOf = (ctx: { requestContext: { get(key: string): unknown } }) => {
  const id = (ctx.requestContext.get('turn') as { runId?: string } | undefined)?.runId ?? ctx.requestContext.get('runId');
  if (typeof id !== 'string' || !id) throw new Error('runId missing from request context');
  return id;
};

export const wfTools = {
  wf_save_input: createTool({
    id: 'wf_save_input',
    description: "Save the customer's answer for an input step (the current one, or a later input with nothing in between). Returns the next step.",
    inputSchema: z.object({ input_id: z.string(), value: z.string() }),
    execute: async (a, ctx) => wfSaveInput(runIdOf(ctx), a),
  }),
  wf_choose_case: createTool({
    id: 'wf_choose_case',
    description: 'Pick the case of the current AI condition. Returns the first step of that branch.',
    inputSchema: z.object({ condition_id: z.string(), case_id: z.string(), reason: z.string() }),
    execute: async (a, ctx) => wfChooseCase(runIdOf(ctx), a),
  }),
  wf_complete_step: createTool({
    id: 'wf_complete_step',
    description: 'Mark the current AI step done. Rejected until its required actions have run. Returns the next step.',
    inputSchema: z.object({ step_id: z.string(), summary: z.string() }),
    execute: async (a, ctx) => wfCompleteStep(runIdOf(ctx), a),
  }),
  call_action: createTool({
    id: 'call_action',
    description: 'Run an action the current step allows. Actions that need approval wait for the team; a repeat returns the first result.',
    inputSchema: z.object({ action_key: z.string(), args: z.record(z.string(), z.unknown()).optional() }),
    execute: async (a, ctx) => wfCallAction(runIdOf(ctx), a),
  }),
  wf_handoff: createTool({
    id: 'wf_handoff',
    description: 'Hand the ticket to a human teammate and stop the workflow.',
    inputSchema: z.object({ reason: z.string() }),
    execute: async (a, ctx) => wfHandoff(runIdOf(ctx), a),
  }),
  wf_switch_workflow: createTool({
    id: 'wf_switch_workflow',
    description: 'Cancel this workflow and start another one the customer clearly asked for (confidence 0.8 or more).',
    inputSchema: z.object({ workflow_id: z.string(), confidence: z.number(), reason: z.string() }),
    execute: async (a, ctx) => wfSwitchWorkflow(runIdOf(ctx), a),
  }),
};

export type WfToolName = keyof typeof wfTools;
