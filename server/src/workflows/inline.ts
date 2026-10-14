import { Inline } from '../types';

// Plain text for prompts: @actions become `key`, {{vars}} get their values.
export function renderInline(content: Inline[], vars: Record<string, string> = {}): string {
  return content
    .map((p) => (p.t === 'text' ? p.v : p.t === 'action' ? `\`${p.key}\`` : vars[p.key] ?? `{{${p.key}}}`))
    .join('')
    .trim();
}

export function stepActions(content: Inline[]): string[] {
  return content.filter((p): p is { t: 'action'; key: string } => p.t === 'action').map((p) => p.key);
}
