import cytoscape from "cytoscape";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ClaimView, EdgeView } from "./api.ts";
import { Chip } from "./ui.tsx";

const STATUSES = ["open", "computed", "proved", "refuted", "proved_informal", "retracted"] as const;

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

const clip = (text: string, n: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
};

/**
 * The research graph, read-only: one node per claim coloured by the status the journal holds, one edge per link. Nothing on it can be
 * dragged, edited or clicked into a change; a tap only shows the claim's text below.
 */
export function Graph(props: { claims: ClaimView[]; edges: EdgeView[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<ClaimView | undefined>();
  const [dark, setDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setDark(query.matches);
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    const el = box.current;
    if (el === null || props.claims.length === 0) return;
    const ids = new Set(props.claims.map((c) => c.id));
    const elements: cytoscape.ElementDefinition[] = props.claims.map((c) => ({ data: { id: c.id, label: `${c.id.slice(0, 14)}\n${c.status}`, status: c.status, target: c.target ? 1 : 0 } }));
    const seen = new Set<string>();
    const link = (from: string, to: string, kind: string, status: string) => {
      if (!ids.has(from) || !ids.has(to) || from === to) return;
      const key = `${from}>${to}>${kind}`;
      if (seen.has(key)) return;
      seen.add(key);
      elements.push({ data: { id: `e${seen.size}`, source: from, target: to, kind, status } });
    };
    for (const c of props.claims) if (c.parent !== null) link(c.parent, c.id, "derived_from", "derived");
    for (const e of props.edges) if (e.kind !== "uses" && e.kind !== "cites") for (const to of e.to) link(e.from, to, e.kind, e.status);
    const text = css("--fg");
    const line = css("--muted");
    const cy = cytoscape({
      container: el,
      elements,
      userPanningEnabled: true,
      userZoomingEnabled: true,
      boxSelectionEnabled: false,
      autoungrabify: true,
      minZoom: 0.2,
      maxZoom: 2.5,
      layout: { name: "breadthfirst", directed: true, spacingFactor: 1.1, padding: 12, roots: props.claims.filter((c) => c.target).map((c) => `#${CSS.escape(c.id)}`) },
      style: [
        { selector: "node", style: { shape: "round-rectangle", width: 118, height: 40, label: "data(label)", "text-wrap": "wrap", "text-valign": "center", "text-halign": "center", "font-size": 10, color: text, "background-color": css("--open"), "border-width": 1, "border-color": line } },
        ...STATUSES.map((s) => ({ selector: `node[status = "${s}"]`, style: { "background-color": css(`--${s}`) } })),
        { selector: "node[target = 1]", style: { "border-width": 3, "border-color": css("--accent") } },
        { selector: "edge", style: { width: 1.5, "line-color": line, "target-arrow-color": line, "target-arrow-shape": "triangle", "curve-style": "bezier", "arrow-scale": 0.8 } },
        { selector: 'edge[status = "lean_checked"]', style: { "line-color": css("--good"), "target-arrow-color": css("--good"), width: 2.5 } },
        { selector: 'edge[status = "human_signed"]', style: { "line-color": css("--accent"), "target-arrow-color": css("--accent"), width: 2.5 } },
        { selector: 'edge[status = "proposed"]', style: { "line-style": "dashed" } },
      ],
    });
    cy.on("tap", "node", (event) => setPicked(props.claims.find((c) => c.id === event.target.id())));
    return () => cy.destroy();
  }, [props.claims, props.edges, dark]);

  if (props.claims.length === 0) return <p class="muted">The journal holds no claim yet.</p>;
  return (
    <>
      <div class="legend" aria-label="Legend">
        {STATUSES.map((s) => (
          <span key={s}>
            <i class={`swatch s-${s}`} />
            {s}
          </span>
        ))}
        <span>
          <i class="swatch target" />a problem's claim
        </span>
      </div>
      <div id="graph" ref={box} role="img" aria-label="The research graph: one box per claim, coloured by its status, with its links. The same facts are in the table below." />
      <p class="small muted">Solid green: a link Lean checked. Blue: a person's signature. Dashed: proposed, not checked. Tap a box to read its claim.</p>
      {picked !== undefined ? (
        <div class="notice">
          <code>{picked.id}</code> <Chip status={picked.status} />
          <div>{picked.statement}</div>
        </div>
      ) : null}
      <details>
        <summary>The same graph as tables</summary>
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>Claim</th>
                <th>Status</th>
                <th>Statement</th>
              </tr>
            </thead>
            <tbody>
              {props.claims.map((c) => (
                <tr key={c.id}>
                  <td>
                    <code>{c.id}</code>
                  </td>
                  <td>
                    <Chip status={c.status} />
                  </td>
                  <td>{clip(c.statement, 240)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {props.edges.length > 0 ? (
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>Edge</th>
                  <th>Kind</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {props.edges.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <code>{e.id}</code>
                    </td>
                    <td>{e.kind}</td>
                    <td>
                      <code>{e.from}</code>
                    </td>
                    <td>{e.to.map((t) => <code key={t}>{t} </code>)}</td>
                    <td>{e.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </details>
    </>
  );
}
