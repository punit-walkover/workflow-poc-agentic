// Rich text in blocks (same shape as the server's): plain text, @action mentions and {{variable}} chips.
export type Inline = { t: 'text'; v: string } | { t: 'action'; key: string } | { t: 'var'; key: string };

export const rid = () => Math.random().toString(36).slice(2, 10);

export const inlineText = (c: Inline[]) => c.map((p) => (p.t === 'text' ? p.v : p.t === 'action' ? `@${p.key}` : `{{${p.key}}}`)).join('');
