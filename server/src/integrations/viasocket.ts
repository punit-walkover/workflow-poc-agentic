import { createHmac } from 'crypto';
import axios from 'axios';

// viaSocket for the POC's single end user (VIASOCKET_UID). Tools are built in viaSocket's own builder.
const env = (k: string) => process.env[k] || '';

// Token for the tool-builder embed (openViasocket). Signed like GTWY's ({ org_id, project_id, user_id });
// unique_identifier keeps the builder on the same end user.
export function builderToken() {
  if (!env('VIASOCKET_EMBED_SECRET')) throw new Error('viaSocket is not configured (VIASOCKET_* in .env)');
  const uid = env('VIASOCKET_UID') || 'workflow-poc-agentic';
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ org_id: env('VIASOCKET_ORG_ID'), project_id: env('VIASOCKET_PROJECT_ID'), user_id: uid, unique_identifier: uid })}`;
  return `${body}.${createHmac('sha256', env('VIASOCKET_EMBED_SECRET')).update(body).digest('base64url')}`;
}

// A tool built in the viaSocket builder: POST the AI's args to its run URL (the URL is the credential).
export async function runFlow(url: string, args: Record<string, unknown>) {
  if (!/^https:\/\/flow\.sokt\.io\/func\/[A-Za-z0-9_-]+$/.test(url)) throw new Error('not a viaSocket flow URL');
  const r = await axios.post(url, args, { timeout: 60_000, validateStatus: () => true });
  const problem = flowError(r.status, r.data);
  if (problem) throw new Error(problem);
  return r.data ?? {};
}

// Flows often answer HTTP 200 and put the failure in the body ({ success: false } or { status: 400, message }).
// Those are failures too, or the run would carry on as if the tool had worked.
export function flowError(httpStatus: number, body: any): string | null {
  const said = (b: any) => String(b?.message ?? b?.error?.message ?? (typeof b?.error === 'string' ? b.error : '') ?? '').trim();
  if (httpStatus >= 400) return said(body) || `flow failed (HTTP ${httpStatus}): ${JSON.stringify(body).slice(0, 300)}`;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const status = Number(body.status ?? body.statusCode);
  if (body.success === false || (Number.isFinite(status) && status >= 400) || (body.error && body.error !== false))
    return said(body) || `flow reported an error: ${JSON.stringify(body).slice(0, 300)}`;
  return null;
}
