/** Channel-neutral mini-markup: a tiny HTML subset every channel can render or strip. */

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const b = (s: string) => `<b>${esc(s)}</b>`;
export const i = (s: string) => `<i>${esc(s)}</i>`;
export const code = (s: string) => `<code>${esc(s)}</code>`;
export const link = (label: string, url: string) => `<a href="${esc(url)}">${esc(label)}</a>`;

/** For channels without rich text. */
export function toPlain(html: string): string {
  return html
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Split long text into chunks that fit a channel limit, preferring line breaks,
 * without cutting through an HTML tag.
 */
export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    const open = rest.lastIndexOf('<', cut);
    const close = rest.lastIndexOf('>', cut);
    if (open > close) cut = open;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

/** Plain text from an LLM or worker → safe markup (keeps **bold** and `code`). */
export function mdToHtml(md: string): string {
  return esc(md)
    .replace(/```[a-z]*\n?([\s\S]*?)```/g, (_m, c: string) => `<pre>${c}</pre>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}
