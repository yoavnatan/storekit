import { escapeHtml as escHtml } from './html-escape.js';

export interface ReadMoreLabels {
  more: string;
  less: string;
}

/**
 * Truncates `el`'s text to `maxLines` and appends an inline "…more" toggle
 * right after the cut — never a separate line of its own. The "less" toggle
 * (shown once expanded) goes on its own line instead, since there's no
 * ellipsis there to set it apart from the text. Truncates by character (not
 * word-array-join) so multi-paragraph descriptions with real newlines
 * survive intact once expanded.
 */
export function initReadMore(el: HTMLElement, maxLines: number, labels: ReadMoreLabels): void {
  const fullText = (el.textContent ?? '').replace(/\r\n/g, '\n').trim();
  if (!fullText) return;

  el.style.whiteSpace = 'pre-line';
  el.textContent = fullText;

  const cs = getComputedStyle(el);
  let lineHeight = parseFloat(cs.lineHeight);
  if (!Number.isFinite(lineHeight)) lineHeight = parseFloat(cs.fontSize) * 1.2;
  const maxHeight = lineHeight * maxLines + 1;

  if (el.scrollHeight <= maxHeight) return; // fits fully — no truncation needed

  function renderCollapsed(text: string): void {
    el.innerHTML = `<span>${escHtml(text)}</span>… <button type="button" class="read-more-toggle">${escHtml(labels.more)}</button>`;
  }
  function renderExpanded(): void {
    // On its own line — with no ellipsis to set it apart here, an inline
    // "less" would read as the last word of the sentence.
    el.innerHTML = `<span>${escHtml(fullText)}</span><br><button type="button" class="read-more-toggle">${escHtml(labels.less)}</button>`;
  }

  // Binary search the longest cut (in characters) whose collapsed rendering
  // — text + ellipsis + toggle button — still fits within maxLines.
  let lo = 0, hi = fullText.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    renderCollapsed(fullText.slice(0, mid));
    if (el.scrollHeight <= maxHeight) lo = mid; else hi = mid - 1;
  }

  // Back off to the previous whitespace so the cut lands on a word boundary.
  let cut = lo;
  while (cut > 0 && !/\s/.test(fullText[cut])) cut--;
  const collapsedText = fullText.slice(0, cut).trimEnd();

  renderCollapsed(collapsedText);

  let expanded = false;
  el.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.read-more-toggle')) return;
    expanded = !expanded;
    if (expanded) renderExpanded(); else renderCollapsed(collapsedText);
  });
}
