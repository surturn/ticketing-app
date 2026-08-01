/**
 * An organiser's description, rendered with its structure intact.
 *
 * Descriptions arrive as plain text that somebody typed or pasted, with blank
 * lines between paragraphs and asterisks or dashes marking a list. Rendered
 * into a single `<p>` that collapses to a wall of prose — every break gone,
 * every bullet run into the sentence before it.
 *
 * This is not a Markdown renderer, and deliberately not. A Markdown library
 * that emits HTML needs sanitising, and an unsanitised one turns every event
 * description into a stored cross-site scripting hole — an organiser is not an
 * attacker, but an organiser's compromised account is. Everything here is a
 * text node inside elements this file creates, so there is no path from a
 * description to markup at all.
 *
 * It recognises exactly what people actually type: paragraphs, bullets, and
 * emphasis by asterisk. Anything else is shown as written.
 */
import type { ReactNode } from 'react';

const BULLET = /^\s*[*\-•]\s+/;

/** Splits on `*bold*` and renders the marked runs strongly, text-only. */
function withEmphasis(line: string, keyPrefix: string): ReactNode[] {
  // Only paired single asterisks with content between them. An unmatched one is
  // punctuation — "5* hotel" — and is left exactly as typed.
  const parts = line.split(/\*([^*\n]+)\*/g);

  return parts.map((part, index) =>
    // Odd indices are the captured groups, i.e. what sat between the asterisks.
    index % 2 === 1 ? (
      <strong key={`${keyPrefix}-${index}`} className="font-semibold text-on-surface">
        {part}
      </strong>
    ) : (
      part
    ),
  );
}

export function RichText({ text, className }: { text: string; className?: string }) {
  // Blank lines separate blocks. A single break inside a block is a soft wrap
  // and is preserved by `whitespace-pre-line` rather than starting a paragraph.
  const blocks = text.split(/\n{2,}/);

  return (
    <div className={className}>
      {blocks.map((block, blockIndex) => {
        const lines = block.split('\n');
        const bulletLines = lines.filter((line) => BULLET.test(line));

        /**
         * A block is a list when every non-empty line in it is a bullet.
         *
         * Requiring all of them, rather than any, keeps a sentence that happens
         * to begin with a dash from turning a paragraph into a one-item list.
         */
        const isList =
          bulletLines.length > 0 &&
          bulletLines.length === lines.filter((line) => line.trim()).length;

        if (isList) {
          return (
            <ul key={blockIndex} className="my-3 ml-5 list-disc space-y-1.5">
              {bulletLines.map((line, index) => (
                <li key={index}>
                  {withEmphasis(line.replace(BULLET, ''), `${blockIndex}-${index}`)}
                </li>
              ))}
            </ul>
          );
        }

        return (
          <p key={blockIndex} className="my-3 whitespace-pre-line first:mt-0 last:mb-0">
            {withEmphasis(block, String(blockIndex))}
          </p>
        );
      })}
    </div>
  );
}
