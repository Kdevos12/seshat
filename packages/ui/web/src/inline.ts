/**
 * The few Markdown marks the doctor's words carry (UX11): `**bold**`, `` `code` `` and bare links, cut into pieces the page draws as
 * text styles, never as HTML. A code piece that reads as a shell command gets a copy button. No Preact here, so the tests import it.
 */

export interface Piece {
  kind: "text" | "code" | "link";
  text: string;
  bold: boolean;
  /** A code piece that is a command a person types in a terminal. */
  command?: boolean;
}

/** The commands the doctor tells a person to type. A word alone (`lake`) is a program named, not a command: a command has an argument. */
const COMMAND = /^(pnpm|npm|npx|apt|brew|lake|elan|docker|chmod|export|curl|git|sudo|harness)\s+\S/;
const LINK = /https?:\/\/[^\s)]+[^\s).,;:]/g;

function linked(text: string, bold: boolean, out: Piece[]): void {
  let at = 0;
  for (const m of text.matchAll(LINK)) {
    if (m.index > at) out.push({ kind: "text", text: text.slice(at, m.index), bold });
    out.push({ kind: "link", text: m[0], bold });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at), bold });
}

/** The pieces of a line. An unpaired mark stays as the character it is. */
export function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  const halves = text.split("**");
  // An odd number of `**` leaves the last one unpaired: it is put back as text.
  const bolds = halves.length % 2 === 1 ? halves : [...halves.slice(0, -2), `${halves[halves.length - 2]}**${halves[halves.length - 1]}`];
  bolds.forEach((part, i) => {
    const bold = i % 2 === 1;
    const ticks = part.split("`");
    const pairs = ticks.length % 2 === 1 ? ticks : [...ticks.slice(0, -2), `${ticks[ticks.length - 2]}\`${ticks[ticks.length - 1]}`];
    pairs.forEach((t, j) => {
      if (t === "") return;
      if (j % 2 === 1) out.push({ kind: "code", text: t, bold, ...(COMMAND.test(t) ? { command: true } : {}) });
      else linked(t, bold, out);
    });
  });
  return out;
}
