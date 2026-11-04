import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";

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
