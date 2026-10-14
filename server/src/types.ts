// Rich text in blocks: plain text, @action mentions and {{variable}} chips.
export type Inline = { t: 'text'; v: string } | { t: 'action'; key: string } | { t: 'var'; key: string };

// save: copy fields of the step's action response into workflow variables (path like "items[0].name").
export interface SaveField { path: string; var: string }
// The engine's view of canvas blocks: an AI step, and a condition (mode 'rules': picked by rules; otherwise the AI judges each case).
export interface StepNode { id: string; type: 'step'; content: Inline[]; save?: SaveField[] }
export interface BranchNode { id: string; type: 'branch'; cases: GraphCase[]; mode?: 'ai' | 'rules' }

// A rule compares a variable with a value, without AI.
export const RULE_OPS = ['=', '!=', 'contains', '>', '<', 'empty', 'not_empty'] as const;
// ref: compare with another variable's value instead of the typed value.
export interface Rule { var: string; op: (typeof RULE_OPS)[number]; value: string; ref?: string }
export const INPUT_FORMATS = ['text', 'email', 'number', 'phone'] as const;
export type InputFormat = (typeof INPUT_FORMATS)[number];

// Canvas form (workflow.graph): groups of items joined by edges. Item ids are unique across the graph.
// step = AI instruction · bubble = fixed message · input = ask and save the reply in a variable · condition = branch.
export interface GraphCase { id: string; kind: 'if' | 'else_if' | 'else'; condition: Inline[]; rules?: Rule[]; join?: 'and' | 'or' }
export type GraphItem =
  | { id: string; type: 'step'; content: Inline[]; save?: SaveField[] }
  | { id: string; type: 'bubble'; content: Inline[] }
  | { id: string; type: 'input'; prompt: Inline[]; saveAs: string; format: InputFormat; retry?: string }
  | { id: string; type: 'condition'; mode?: 'ai' | 'rules'; cases: GraphCase[] };
export interface GraphGroup { id: string; title: string; x: number; y: number; items: GraphItem[] }
// from: a group's end (no itemId) or a condition case (itemId + port = case id). to: a group, or a step inside one.
export interface GraphEdge {
  id: string;
  from: { groupId: string; itemId?: string; port?: string };
  to: { groupId: string; itemId?: string };
  maxVisits?: number; // required on edges that close a loop
  fresh?: boolean;    // "ask again" when looping back
}
export interface WorkflowGraph { start: string; groups: GraphGroup[]; edges: GraphEdge[]; variables?: string[] } // variables: the workflow's own {{names}}

export interface ActionRow {
  key: string;
  name: string;
  description: string;
  builtin: boolean;
  input_schema: { type: 'object'; properties: Record<string, { type: string }>; required?: string[] };
  requires_approval: boolean;
  enabled: boolean;
  source: 'builtin' | 'viasocket_flow';
  via_flow_id: string | null;
  via_flow_url: string | null;
  details_edited: boolean;
}

export type RunStatus =
  | 'running' | 'waiting_customer' | 'waiting_approval' | 'paused' | 'failed'
  | 'completed' | 'escalated' | 'expired' | 'cancelled';

export const ACTIVE: RunStatus[] = ['running', 'waiting_customer', 'waiting_approval', 'paused', 'failed'];

export interface Facts {
  collected: Record<string, unknown>;
  outputs: Record<string, unknown>;
  cases: Record<string, { case_id: string | null; reason: string }>;
  attempts: Record<string, number>;
  visits: Record<string, number>; // loop edge id -> visit number of its target
  since?: Record<string, string | { at: string; fresh: boolean }>; // node id -> when a loop jumped back over it
  previous?: Record<string, unknown>; // node id -> its result before the last jump back
  collectedBy?: Record<string, string[]>; // node id -> collected keys it filled
  vars?: Record<string, unknown>;     // the workflow's own variables (inputs and saved responses); the AI can't overwrite them
  varsBy?: Record<string, string[]>;  // block id -> variables it filled ("ask again" clears them on a loop back)
  asked?: Record<string, string>; // input block id -> when it last asked (its answer is the next customer message)
  trail?: string[]; // item ids in the order they finished (finds what a loop back re-runs)
}

export type WaitingFor =
  | { type: 'customer'; node_id: string; expects: string[]; remind_at: number; expires_at: number; reminded: boolean }
  | { type: 'approval'; node_id: string; task_id: string; due_at: number };

// Text bubbles waiting to go out: the agent's next reply must contain each one word for word.
export interface OutboxItem { text: string; verbatim: true; nodeId?: string }

export interface RunRow {
  id: string;
  conversation_id: string;
  workflow_id: string;
  workflow_name: string;
  graph: WorkflowGraph; // the published graph this run started on (publishing later doesn't change it)
  status: RunStatus;
  current_node_id: string | null;
  facts: Facts;
  waiting_for: WaitingFor | null;
  outbox: OutboxItem[];
  paused_from: { status: RunStatus; waiting_for: WaitingFor | null } | null;
}

export const VARIABLES = [
  { key: 'customer.name', label: 'Customer name' },
  { key: 'customer.email', label: 'Customer email' },
  { key: 'today', label: "Today's date" },
];
