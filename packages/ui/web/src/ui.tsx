import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { pieces } from "./inline.ts";

/** Small pieces shared by the screens. Everything here puts text on the page as text. */

export function Section(props: { title: string; id?: string | undefined; children: ComponentChildren; note?: string | undefined }) {
  return (
    <section class="card" id={props.id}>
      <h2>{props.title}</h2>
      {props.note !== undefined ? <p class="muted">{props.note}</p> : null}
      {props.children}
    </section>
  );
}

export function Notice(props: { kind?: "error" | "warn" | "info"; children: ComponentChildren }) {
  return (
    <div class={`notice ${props.kind ?? "info"}`} role={props.kind === "error" ? "alert" : "status"}>
      {props.children}
    </div>
  );
}

/** A statement cut to its first words, on one line: what a person reads in place of a claim id (UX4). */
export function words(text: string, max = 60): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** A length of time in words: 45 s, 12 min, 3 h 05. */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600);
  return `${h} h ${String(Math.round((seconds % 3600) / 60)).padStart(2, "0")}`;
}

/** A date and time in the reader's own locale and clock. */
export const when = (ms: number): string => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const money = (usd: number): string => (usd < 0.01 && usd > 0 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

/** Copies text; falls back to a selection when the clipboard is not available (a page that is not a secure context). */
export function CopyButton(props: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.text);
      setState("done");
    } catch {
      const area = document.createElement("textarea");
      area.value = props.text;
      area.setAttribute("readonly", "");
      area.className = "offscreen";
      document.body.appendChild(area);
      area.select();
      try {
        setState(document.execCommand("copy") ? "done" : "failed");
      } catch {
        setState("failed");
      }
      area.remove();
    }
    setTimeout(() => setState("idle"), 2000);
  };
  return (
    <button type="button" class="ghost" onClick={copy}>
      {state === "done" ? "Copied" : state === "failed" ? "Could not copy: select the text" : (props.label ?? "Copy")}
    </button>
  );
}

/** A status as a labelled chip: the words carry the meaning, the colour only helps. */
export function Chip(props: { status: string }) {
  const known = ["open", "computed", "refuted", "proved", "proved_informal", "retracted"].includes(props.status);
  return <span class={`chip s-${known ? props.status : "unknown"}`}>{props.status}</span>;
}

export function Code(props: { text: string; label?: string }) {
  return <pre class="code" aria-label={props.label}>{props.text}</pre>;
}

/** A line of the doctor's words with its marks drawn as styles (UX11): bold, code, links; a command gets a copy button. */
export function Inline(props: { text: string }) {
  return (
    <>
      {pieces(props.text).map((p, i) => {
        const body =
          p.kind === "code" ? (
            <code>{p.text}</code>
          ) : p.kind === "link" ? (
            <a href={p.text} target="_blank" rel="noopener noreferrer">
              {p.text}
            </a>
          ) : (
            p.text
          );
        return (
          <span key={i} class={p.command === true ? "command" : undefined}>
            {p.bold ? <strong>{body}</strong> : body}
            {p.command === true ? <CopyButton text={p.text} label="Copy" /> : null}
          </span>
        );
      })}
    </>
  );
}
