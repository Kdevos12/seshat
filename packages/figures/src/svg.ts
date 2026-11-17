/**
 * A small, dependency-free SVG toolkit for Seshat's figures.
 *
 * Every figure of documentation/images is a TypeScript function over this module, so that a figure is
 * reviewed as code, regenerated with `pnpm figures`, and checked by a test against the file in the
 * repository. The style is fixed here, once: one palette of roles, one set of status marks, one font
 * scale, so that every figure reads the same way.
 */

import { logoMark, logoWidth } from "./logo.ts";

/** What a box stands for. Each role has one colour in every figure. */
export type Role =
  | "lean" // Lean: the judge, its checks and its tools
  | "model" // language models through their APIs
  | "cpu" // classical tools: tactics, SMT, ATPs, computer algebra, search without a model
  | "truth" // the journal and what is rebuilt from it
  | "control" // the orchestrator, budgets, ledgers, schedulers
  | "human" // people: the research team, signatures
  | "external" // services outside the machine: literature, OEIS, LMFDB, Jev
  | "neutral"; // inputs, outputs, files

/** How far a part has gone: run for real, tested with simulations only, or planned. */
export type Status = "real" | "sim" | "planned" | "none";

interface RoleStyle {
  fill: string;
  stroke: string;
  ink: string;
  label: string;
}

export const ROLES: Record<Role, RoleStyle> = {
  lean: { fill: "#e6f2ea", stroke: "#2e7448", ink: "#1d4a2e", label: "Lean: the judge" },
  model: { fill: "#efe9f7", stroke: "#6a4c9c", ink: "#45306a", label: "Language models (APIs)" },
  cpu: { fill: "#e5eff8", stroke: "#2a6496", ink: "#1b4266", label: "Classical tools (no model)" },
  truth: { fill: "#fbf2dd", stroke: "#a87414", ink: "#6b4a0c", label: "Journal and projections" },
  control: { fill: "#eceff3", stroke: "#4a5567", ink: "#2b3340", label: "Orchestration and budgets" },
  human: { fill: "#fae8ee", stroke: "#ad4468", ink: "#6e2540", label: "People" },
  external: { fill: "#e4f3f2", stroke: "#2b7d78", ink: "#1a4f4c", label: "Third-party services" },
  neutral: { fill: "#ffffff", stroke: "#8b94a5", ink: "#2b3340", label: "Inputs and outputs" },
};

export const INK = "#1f2633";
export const MUTED = "#5b6475";
export const FAINT = "#9aa2b1";
export const RULE = "#d5dae2";
export const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
export const MONO = "Menlo, Consolas, 'DejaVu Sans Mono', monospace";

/** Helvetica advance widths for ASCII 32..126, in thousandths of an em (Arial has the same metrics). */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
  556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
  260, 334, 584,
];

/** A run of text in one face: plain, bold, code or italic. */
export interface Span {
  text: string;
  bold?: boolean;
  mono?: boolean;
  italic?: boolean;
}

/** Splits `a **b** \`c\` _d_` into spans. */
export function spans(line: string): Span[] {
  const out: Span[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g;
  let last = 0;
  for (const m of line.matchAll(re)) {
    if (m.index > last) out.push({ text: line.slice(last, m.index) });
    const t = m[0];
    if (t.startsWith("**")) out.push({ text: t.slice(2, -2), bold: true });
    else if (t.startsWith("`")) out.push({ text: t.slice(1, -1), mono: true });
    else out.push({ text: t.slice(1, -1), italic: true });
    last = m.index + t.length;
  }
  if (last < line.length) out.push({ text: line.slice(last) });
  return out;
}

/** The width of a run of text at a font size, from Helvetica's metrics (bold is about 6% wider). */
export function spanWidth(span: Span, size: number): number {
  if (span.mono) return span.text.length * 0.6 * size;
  let units = 0;
  for (const ch of span.text) {
    const code = ch.codePointAt(0)!;
    units += code >= 32 && code <= 126 ? HELVETICA[code - 32]! : 600;
  }
  return (units / 1000) * size * (span.bold ? 1.06 : 1);
}

export function lineWidth(line: string, size: number, bold = false): number {
  return spans(line).reduce((sum, s) => sum + spanWidth(bold ? { ...s, bold: true } : s, size), 0);
}

export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
}

export type Point = [number, number];

export interface TextOptions {
  size?: number;
  bold?: boolean;
  color?: string;
  anchor?: "start" | "middle" | "end";
  halo?: boolean;
  italic?: boolean;
  spacing?: number;
}

/** One line of text with inline spans; returns the SVG element. */
export function textLine(x: number, y: number, line: string, o: TextOptions = {}): string {
  const size = o.size ?? 12;
  const attrs = [
    `x="${num(x)}"`,
    `y="${num(y)}"`,
    `font-size="${num(size)}"`,
    `fill="${o.color ?? INK}"`,
    o.anchor && o.anchor !== "start" ? `text-anchor="${o.anchor}"` : "",
    o.bold ? `font-weight="700"` : "",
    o.italic ? `font-style="italic"` : "",
    o.spacing ? `letter-spacing="${o.spacing}"` : "",
    o.halo ? `stroke="#ffffff" stroke-width="4" stroke-linejoin="round" paint-order="stroke"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const body = spans(line)
    .map((s) => {
      const a = [
        s.mono ? `font-family="${MONO}" font-size="${num(size * 0.92)}"` : "",
        s.bold ? `font-weight="700"` : "",
        s.italic ? `font-style="italic"` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return a ? `<tspan ${a}>${esc(s.text)}</tspan>` : esc(s.text);
    })
    .join("");
  return `<text ${attrs}>${body}</text>`;
}

/** An anchorable rectangle. */
export class Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  constructor(x: number, y: number, w: number, h: number) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
  }
  get cx(): number {
    return this.x + this.w / 2;
  }
  get cy(): number {
    return this.y + this.h / 2;
  }
  get r(): number {
    return this.x + this.w;
  }
  get b(): number {
    return this.y + this.h;
  }
  /** A point on the top side, `t` from 0 (left) to 1 (right). */
  top(t = 0.5): Point {
    return [this.x + this.w * t, this.y];
  }
  bottom(t = 0.5): Point {
    return [this.x + this.w * t, this.b];
  }
  left(t = 0.5): Point {
    return [this.x, this.y + this.h * t];
  }
  right(t = 0.5): Point {
    return [this.r, this.y + this.h * t];
  }
}

export interface BoxOptions {
  role?: Role;
  status?: Status;
  title?: string;
  lines?: string[];
  icon?: IconName;
  /** Body text size; titles are one point larger. */
  size?: number;
  align?: "middle" | "start";
  /** Corner tag, top right, such as "M10" or "§3". */
  tag?: string;
  /** A heavier border, for the one box a figure is about. */
  strong?: boolean;
  /** Fill the box with white instead of the role's tint. */
  plain?: boolean;
  radius?: number;
}

export interface ArrowOptions {
  color?: string;
  dashed?: boolean;
  /** Arrowheads: at the end (default), both ends, or none. */
  heads?: "end" | "both" | "none";
  width?: number;
  label?: string | string[];
  /** Where the label goes; by default the middle of the longest segment. */
  labelAt?: Point;
  labelAnchor?: "start" | "middle" | "end";
  /** Radius of the rounded corners. */
  radius?: number;
}

export type IconName =
  | "lean"
  | "model"
  | "cpu"
  | "journal"
  | "human"
  | "coin"
  | "doc"
  | "search"
  | "graph"
  | "blocks"
  | "clock"
  | "lock"
  | "loop"
  | "flag"
  | "terminal";

/** Small line icons, drawn in a 20 x 20 box at (x, y). */
export function icon(name: IconName, x: number, y: number, color: string, size = 18): string {
  const s = size / 20;
  const g = (body: string) =>
    `<g transform="translate(${num(x)},${num(y)}) scale(${num(Math.round(s * 100) / 100)})" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
  switch (name) {
    case "lean": // a shield with a check mark
      return g(`<path d="M10 1.5 L17.5 4.5 V10 C17.5 14.5 14 17.5 10 18.8 C6 17.5 2.5 14.5 2.5 10 V4.5 Z"/><path d="M6.5 10.2 L9 12.7 L13.8 7.6"/>`);
    case "model": // a four-point spark and a small one
      return g(`<path d="M8 2 C8.8 6.6 10.4 8.2 15 9 C10.4 9.8 8.8 11.4 8 16 C7.2 11.4 5.6 9.8 1 9 C5.6 8.2 7.2 6.6 8 2 Z"/><path d="M15.5 12.5 C15.8 14.2 16.3 14.7 18 15 C16.3 15.3 15.8 15.8 15.5 17.5 C15.2 15.8 14.7 15.3 13 15 C14.7 14.7 15.2 14.2 15.5 12.5 Z"/>`);
    case "cpu": // a chip
      return g(`<rect x="5" y="5" width="10" height="10" rx="1.5"/><rect x="8" y="8" width="4" height="4"/><path d="M8 2v3M12 2v3M8 15v3M12 15v3M2 8h3M2 12h3M15 8h3M15 12h3"/>`);
    case "journal": // a cylinder
      return g(`<ellipse cx="10" cy="4.5" rx="7" ry="2.5"/><path d="M3 4.5v11c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-11"/><path d="M3 10c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>`);
    case "human": // a person
      return g(`<circle cx="10" cy="6" r="3.3"/><path d="M3.5 18c0-3.9 2.9-6.5 6.5-6.5s6.5 2.6 6.5 6.5"/>`);
    case "coin": // a coin with a dollar sign
      return g(`<circle cx="10" cy="10" r="8"/><path d="M12.6 7.2c-.5-.9-1.5-1.4-2.6-1.4-1.5 0-2.6.8-2.6 2s1.1 1.7 2.6 2c1.6.3 2.7.9 2.7 2.1s-1.2 2-2.7 2c-1.2 0-2.2-.5-2.7-1.4M10 4.2v1.6M10 14v1.8"/>`);
    case "doc": // a page with a folded corner
      return g(`<path d="M4 1.8h8l4 4v12.4H4z"/><path d="M12 1.8v4h4M7 10h6M7 13h6"/>`);
    case "search": // a magnifier
      return g(`<circle cx="8.5" cy="8.5" r="5.5"/><path d="M12.5 12.5L18 18"/>`);
    case "graph": // three joined nodes
      return g(`<circle cx="4" cy="15" r="2.3"/><circle cx="16" cy="15" r="2.3"/><circle cx="10" cy="4.5" r="2.3"/><path d="M5.2 13l3.6-6.4M14.8 13l-3.6-6.4M6.3 15h7.4"/>`);
    case "blocks": // four tiles: a registry of parts
      return g(`<rect x="2" y="2" width="7" height="7" rx="1"/><rect x="11" y="2" width="7" height="7" rx="1"/><rect x="2" y="11" width="7" height="7" rx="1"/><path d="M14.5 11v7M11 14.5h7"/>`);
    case "clock":
      return g(`<circle cx="10" cy="10" r="8"/><path d="M10 5.5V10l3 2"/>`);
    case "lock":
      return g(`<rect x="3.5" y="9" width="13" height="9" rx="1.5"/><path d="M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9"/>`);
    case "loop": // a circular arrow
      return g(`<path d="M16.5 10a6.5 6.5 0 1 1-2-4.7"/><path d="M15 1.8v4h-4"/>`);
    case "flag":
      return g(`<path d="M4 18.5V2"/><path d="M4 3h11l-2.5 4L15 11H4"/>`);
    case "terminal":
      return g(`<rect x="1.8" y="3" width="16.4" height="14" rx="1.5"/><path d="M5.5 8l3 2.5-3 2.5M10.5 13.5h4"/>`);
  }
}

/** Marks drawn in a box's border for its status. */
function statusDash(status: Status): string {
  if (status === "sim") return `stroke-dasharray="5 3"`;
  if (status === "planned") return `stroke-dasharray="1.5 3"`;
  return "";
}

export interface LegendItem {
  role?: Role;
  status?: Status;
  arrow?: { dashed?: boolean; color?: string };
  label: string;
}

/**
 * A figure: a canvas, a title, a subtitle, and elements added in drawing order. Boxes check that their text
 * fits; a figure that does not fit throws when it is built, so that a test catches it.
 */
export class Figure {
  private readonly layers: { back: string[]; mid: string[]; front: string[] } = { back: [], mid: [], front: [] };
  readonly problems: string[] = [];
  private markers = new Set<string>();

  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly subtitle: string | undefined;

  constructor(width: number, height: number, title: string, subtitle?: string) {
    this.width = width;
    this.height = height;
    this.title = title;
    this.subtitle = subtitle;
  }

  /** The top of the drawing area, below the title and subtitle. */
  get top(): number {
    return this.subtitle ? 66 : 46;
  }

  private marker(color: string): string {
    const id = `ah-${color.replace("#", "")}`;
    this.markers.add(color);
    return id;
  }

  raw(svg: string, layer: "back" | "mid" | "front" = "mid"): void {
    this.layers[layer].push(svg);
  }

  /** A titled region that groups boxes, drawn behind them. */
  panel(
    x: number,
    y: number,
    w: number,
    h: number,
    label?: string,
    o: { role?: Role; dashed?: boolean; note?: string } = {},
  ): Rect {
    const st = o.role ? ROLES[o.role] : undefined;
    const fill = st ? tint(st.fill, 0.45) : "#f7f8fa";
    const stroke = st ? st.stroke : RULE;
    this.layers.back.push(
      `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="10" fill="${fill}" stroke="${stroke}" stroke-opacity="${st ? 0.55 : 1}" stroke-width="1.2"${o.dashed ? ` stroke-dasharray="6 4"` : ""}/>`,
    );
    if (label) {
      this.layers.back.push(
        textLine(x + 12, y + 18, label.toUpperCase().replace(/^\(([A-Z])\)/, (_, l: string) => `(${l.toLowerCase()})`), {
          size: 10.5,
          bold: true,
          color: st ? st.ink : MUTED,
          spacing: 0.8,
        }),
      );
    }
    if (o.note) this.layers.back.push(textLine(x + w - 12, y + 18, o.note, { size: 10.5, color: MUTED, anchor: "end", italic: true }));
    return new Rect(x, y, w, h);
  }

  /** A box with a bold title and body lines. */
  box(x: number, y: number, w: number, h: number, o: BoxOptions = {}): Rect {
    const role = o.role ?? "neutral";
    const st = ROLES[role];
    const status = o.status ?? "none";
    const size = o.size ?? 11.5;
    const tsize = size + 1;
    const lh = size * 1.3;
    const radius = o.radius ?? 6;
    const fill = o.plain ? "#ffffff" : status === "planned" ? "#f6f7f9" : st.fill;
    const stroke = status === "planned" ? FAINT : st.stroke;
    this.layers.mid.push(
      `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${o.strong ? 2.4 : 1.4}" ${statusDash(status)}/>`,
    );
    const lines = o.lines ?? [];
    const iconW = o.icon ? 22 : 0;
    const titleH = o.title ? tsize * 1.3 : 0;
    const blockH = titleH + lines.length * lh - (lines.length || o.title ? size * 0.3 : 0);
    let ty = y + (h - blockH) / 2 + size * 0.95;
    const align = o.align ?? "middle";
    const tx = align === "middle" ? x + w / 2 : x + 10;
    const pad = 8;
    if (o.title) {
      const tw = lineWidth(o.title, tsize, true) + iconW;
      if (tw > w - 2 * pad - (o.tag ? lineWidth(o.tag, 9.5) + 6 : 0))
        this.problems.push(`title "${o.title}" (${tw.toFixed(0)}px) overflows its box (${w}px)`);
      const startX = align === "middle" ? x + w / 2 - tw / 2 : x + 10;
      if (o.icon) this.layers.mid.push(icon(o.icon, startX, ty - tsize * 0.95 - 1.5, st.stroke, 17));
      this.layers.mid.push(
        textLine(startX + iconW, ty + 0.5, o.title, { size: tsize, bold: true, color: status === "planned" ? MUTED : st.ink }),
      );
      ty += titleH;
    }
    for (const line of lines) {
      const lw = lineWidth(line, size);
      if (lw > w - 2 * pad) this.problems.push(`line "${line}" (${lw.toFixed(0)}px) overflows its box (${w}px)`);
      this.layers.mid.push(textLine(tx, ty, line, { size, color: status === "planned" ? MUTED : INK, anchor: align }));
      ty += lh;
    }
    if (blockH > h - 6) this.problems.push(`text of "${o.title ?? lines[0]}" overflows the box height (${h}px)`);
    if (o.tag) {
      this.layers.mid.push(
        textLine(x + w - 7, y + 13, o.tag, { size: 9.5, bold: true, color: st.stroke, anchor: "end", spacing: 0.4 }),
      );
    }
    return new Rect(x, y, w, h);
  }

  /** A pill: a short label in a rounded capsule. */
  pill(x: number, y: number, text: string, o: { role?: Role; status?: Status; size?: number; w?: number } = {}): Rect {
    const size = o.size ?? 10.5;
    const st = ROLES[o.role ?? "neutral"];
    const w = o.w ?? lineWidth(text, size, true) + 16;
    const h = size + 9;
    const status = o.status ?? "none";
    this.layers.mid.push(
      `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="${num(h / 2)}" fill="${status === "planned" ? "#f6f7f9" : st.fill}" stroke="${status === "planned" ? FAINT : st.stroke}" stroke-width="1.2" ${statusDash(status)}/>`,
    );
    this.layers.mid.push(textLine(x + w / 2, y + h / 2 + size * 0.36, text, { size, bold: true, color: st.ink, anchor: "middle" }));
    return new Rect(x, y, w, h);
  }

  /** Free text; several lines are stacked. */
  text(x: number, y: number, lines: string | string[], o: TextOptions = {}): void {
    const size = o.size ?? 12;
    const list = Array.isArray(lines) ? lines : [lines];
    list.forEach((line, i) => this.layers.front.push(textLine(x, y + i * size * 1.3, line, o)));
  }

  /** A numbered disc, for steps. */
  badge(x: number, y: number, label: string, color = INK, r = 9): void {
    this.layers.front.push(
      `<circle cx="${num(x)}" cy="${num(y)}" r="${r}" fill="${color}"/>` +
        textLine(x, y + 3.6, label, { size: 10.5, bold: true, color: "#ffffff", anchor: "middle" }),
    );
  }

  /** An orthogonal polyline with rounded corners and arrowheads. */
  arrow(points: Point[], o: ArrowOptions = {}): void {
    const color = o.color ?? "#3b4456";
    const width = o.width ?? 1.4;
    const radius = o.radius ?? 7;
    const heads = o.heads ?? "end";
    const id = this.marker(color);
    let d = `M${num(points[0]![0])},${num(points[0]![1])}`;
    for (let i = 1; i < points.length; i++) {
      const p = points[i]!;
      if (i < points.length - 1) {
        const prev = points[i - 1]!;
        const next = points[i + 1]!;
        const r = Math.min(radius, dist(prev, p) / 2, dist(p, next) / 2);
        const a = toward(p, prev, r);
        const b = toward(p, next, r);
        d += ` L${num(a[0])},${num(a[1])} Q${num(p[0])},${num(p[1])} ${num(b[0])},${num(b[1])}`;
      } else d += ` L${num(p[0])},${num(p[1])}`;
    }
    this.layers.mid.push(
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}"${o.dashed ? ` stroke-dasharray="5 4"` : ""}${heads !== "none" ? ` marker-end="url(#${id})"` : ""}${heads === "both" ? ` marker-start="url(#${id})"` : ""}/>`,
    );
    if (o.label) {
      const lines = Array.isArray(o.label) ? o.label : [o.label];
      let at = o.labelAt;
      if (!at) {
        let best = 0;
        for (let i = 1; i < points.length; i++) {
          const len = dist(points[i - 1]!, points[i]!);
          if (len > best) {
            best = len;
            const [a, b] = [points[i - 1]!, points[i]!];
            at = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - (a[1] === b[1] ? 6 : 0)];
          }
        }
      }
      const size = 10.5;
      const y0 = at![1] - ((lines.length - 1) * size * 1.25) / 2 + size * 0.35;
      lines.forEach((line, i) =>
        this.layers.front.push(
          textLine(at![0], y0 + i * size * 1.25, line, {
            size,
            color: MUTED,
            anchor: o.labelAnchor ?? "middle",
            halo: true,
            italic: false,
          }),
        ),
      );
    }
  }

  /** A legend row at (x, y); returns its width. */
  legend(x: number, y: number, items: LegendItem[]): number {
    let cx = x;
    for (const it of items) {
      if (it.arrow) {
        const c = it.arrow.color ?? "#3b4456";
        const id = this.marker(c);
        this.layers.front.push(
          `<path d="M${num(cx)},${num(y)} L${num(cx + 26)},${num(y)}" stroke="${c}" stroke-width="1.4" fill="none"${it.arrow.dashed ? ` stroke-dasharray="5 4"` : ""} marker-end="url(#${id})"/>`,
        );
        cx += 32;
      } else {
        const st = ROLES[it.role ?? "neutral"];
        const status = it.status ?? "none";
        this.layers.front.push(
          `<rect x="${num(cx)}" y="${num(y - 7)}" width="22" height="14" rx="3" fill="${status === "planned" ? "#f6f7f9" : it.role ? st.fill : "#ffffff"}" stroke="${status === "planned" ? FAINT : it.role ? st.stroke : "#4a5567"}" stroke-width="1.4" ${statusDash(status)}/>`,
        );
        cx += 28;
      }
      this.layers.front.push(textLine(cx, y + 4, it.label, { size: 10.5, color: MUTED }));
      cx += lineWidth(it.label, 10.5) + 26;
    }
    return cx - x;
  }

  /** The standard legend of status marks. */
  statusLegend(x: number, y: number, which: Status[] = ["real", "sim"]): number {
    const label: Record<Status, string> = {
      real: "has run for real (Lean 4.27, a real model)",
      sim: "built, tested with simulations only",
      planned: "planned, not written",
      none: "",
    };
    return this.legend(
      x,
      y,
      which.map((s) => ({ status: s, label: label[s] })),
    );
  }

  toString(): string {
    const defs = [...this.markers]
      .sort()
      .map(
        (c) =>
          `<marker id="ah-${c.replace("#", "")}" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse"><path d="M0.5,0.8 L9.5,5 L0.5,9.2 L2.6,5 z" fill="${c}"/></marker>`,
      )
      .join("");
    // The logo, top right, above the drawing area; the title and subtitle must end before it.
    const logoH = 40;
    const logoX = this.width - 20 - logoWidth(logoH);
    for (const [text, size, bold] of [[this.title, 17, true], [this.subtitle ?? "", 12, false]] as const) {
      const end = 24 + lineWidth(text, size, bold);
      if (end > logoX - 12) this.problems.push(`"${text.slice(0, 40)}" (ends at ${end.toFixed(0)}px) runs into the logo (${logoX.toFixed(0)}px)`);
    }
    const head = [
      `<rect x="0" y="0" width="${this.width}" height="${this.height}" fill="#ffffff"/>`,
      logoMark(logoX, 6, logoH),
      textLine(24, 32, this.title, { size: 17, bold: true }),
      this.subtitle ? textLine(24, 52, this.subtitle, { size: 12, color: MUTED }) : "",
    ].join("\n");
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.width} ${this.height}" width="${this.width}" height="${this.height}" font-family="${FONT}" role="img" aria-labelledby="title">`,
      `<title id="title">${esc(this.title)}</title>`,
      `<defs>${defs}</defs>`,
      head,
      ...this.layers.back,
      ...this.layers.mid,
      ...this.layers.front,
      `</svg>`,
      "",
    ].join("\n");
  }
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function toward(from: Point, to: Point, r: number): Point {
  const d = dist(from, to) || 1;
  return [from[0] + ((to[0] - from[0]) * r) / d, from[1] + ((to[1] - from[1]) * r) / d];
}

/** Mixes a colour with white: `amount` 1 keeps it, 0 is white. */
export function tint(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(255 - (255 - c) * amount));
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
