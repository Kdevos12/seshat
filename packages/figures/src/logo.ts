/**
 * Seshat's logo (assets/logo/seshat.svg, traced from the owner's drawing), placed as a mark in the corner of every
 * figure. The file is the source: this module reads its view box and its paths, so a new logo changes every figure
 * at the next `pnpm figures`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LOGO_FILE = fileURLToPath(new URL("../../../assets/logo/seshat.svg", import.meta.url));

const source = readFileSync(LOGO_FILE, "utf8");
const box = /viewBox="([^"]+)"/.exec(source)?.[1]?.split(/\s+/).map(Number) ?? [];
if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) throw new Error(`${LOGO_FILE}: no view box`);
const [vx, vy, vw, vh] = box as [number, number, number, number];
const paths = [...source.matchAll(/<path [^>]*\/>/g)].map((m) => m[0]).join("");

/** The width of the logo drawn at `height`. */
export function logoWidth(height: number): number {
  return (vw * height) / vh;
}

/** The logo drawn with its top left corner at (x, y), `height` high. */
export function logoMark(x: number, y: number, height: number): string {
  const s = height / vh;
  const f = (n: number) => Number(n.toFixed(4)).toString();
  return `<g aria-hidden="true" transform="translate(${f(x - vx * s)} ${f(y - vy * s)}) scale(${f(s)})">${paths}</g>`;
}
