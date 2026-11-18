import { useEffect, useState } from "preact/hooks";
import { del, get, message, put, type Provider } from "./api.ts";
import { Notice, Section } from "./ui.tsx";

interface Session {
  keyFile: { path: string; ok: boolean; problem?: string };
}

/** The providers of the library, as it lists them now, and a place to keep each one's key. A saved key is never shown again. */
export function Settings() {
  const [providers, setProviders] = useState<Provider[] | undefined>();
  const [recommended, setRecommended] = useState<string[]>([]);
  const [session, setSession] = useState<Session | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [open, setOpen] = useState<string | undefined>();
  const [key, setKey] = useState("");
  const [filter, setFilter] = useState("");

  const load = () => {
    get<{ providers: Provider[]; recommended?: string[] }>("/api/providers").then(
      (r) => {
        setProviders(r.providers);
        setRecommended(r.recommended ?? []);
      },
      (e) => setError(message(e)),
    );
    get<Session>("/api/session").then(setSession, () => {});
  };
  useEffect(load, []);

  const save = async (id: string) => {
    setError(undefined);
    try {
      await put(`/api/providers/${encodeURIComponent(id)}/key`, { key: key.trim() });
      setKey("");
      setOpen(undefined);
      load();
    } catch (e) {
      setError(message(e));
    }
  };
  const remove = async (id: string) => {
    setError(undefined);
    try {
      await del(`/api/providers/${encodeURIComponent(id)}/key`);
      load();
    } catch (e) {
      setError(message(e));
    }
  };

  const needle = filter.trim().toLowerCase();
  const shown = (providers ?? []).filter((p) => needle === "" || p.id.includes(needle) || p.name.toLowerCase().includes(needle));
  // UX11: the providers with credentials first, then the host profile's recommended ones (none in the shipped profiles), the rest folded.
  const isRecommended = (p: Provider) => recommended.some((r) => (r.endsWith("/*") ? r.slice(0, -2) === p.id : r.startsWith(`${p.id}/`)));
  const ready = shown.filter((p) => p.configured);
  const advised = shown.filter((p) => !p.configured && isRecommended(p));
  const others = shown.filter((p) => !p.configured && !isRecommended(p));

  const item = (p: Provider) => (
    <li key={p.id}>
      <div class="row">
        <div>
          <strong>{p.name}</strong> <code class="muted">{p.id}</code>
          <div class="small muted">
            {p.models} model(s). {p.cheapest !== null ? `From $${p.cheapest.price.toFixed(2)} per million tokens, input plus output (${p.cheapest.id}). ` : ""}
            {p.configured ? `Credentials found: ${p.source ?? "yes"}.` : "No credentials."}
          </div>
        </div>
        <div class="actions">
          {p.variable === null ? (
            <span class="small muted">No key to save: this provider uses other credentials.</span>
          ) : open === p.id ? null : (
            <button type="button" class="ghost" onClick={() => { setOpen(p.id); setKey(""); setError(undefined); }}>
              {p.stored ? "Replace key" : "Add key"}
            </button>
          )}
          {p.stored ? (
            <button type="button" class="danger" onClick={() => remove(p.id)}>
              Remove key
            </button>
          ) : null}
        </div>
      </div>
      {open === p.id ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save(p.id);
          }}
        >
          <label for={`key-${p.id}`}>
            Key, kept as <code>{p.variable}</code>
          </label>
          <input id={`key-${p.id}`} type="password" autocomplete="off" spellcheck={false} value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
          <div class="actions">
            <button type="submit" disabled={key.trim().length < 8}>
              Save
            </button>
            <button type="button" class="ghost" onClick={() => { setOpen(undefined); setKey(""); }}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </li>
  );

  return (
    <>
      <h1>Model providers</h1>
      <p class="muted">
        The list is what the model library knows now. A key you save here is kept in a file only you can read, outside the repository, and handed to the commands this page starts. It is never shown again and never written to a run.
      </p>
      {session !== undefined ? (
        <p class="small muted">
          Key file: <code>{session.keyFile.path}</code>
        </p>
      ) : null}
      {session?.keyFile.ok === false ? <Notice kind="error">{session.keyFile.problem}</Notice> : null}
      {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
      <label for="filter">Find a provider</label>
      <input id="filter" type="text" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
      <div class="card">
        {providers === undefined ? <p class="muted">Loading...</p> : null}
        {providers !== undefined && shown.length === 0 ? <p class="muted">No provider matches.</p> : null}
        {ready.length > 0 ? (
          <section class="providers" data-part="ready" aria-label="With credentials">
            <h2>With credentials</h2>
            <ul class="plain">{ready.map(item)}</ul>
          </section>
        ) : null}
        {advised.length > 0 ? (
          <section class="providers" data-part="recommended" aria-label="Recommended for cost">
            <h2>Recommended for cost</h2>
            <p class="small muted">The host profile's own list (its "recommended"): Seshat itself prefers no provider.</p>
            <ul class="plain">{advised.map(item)}</ul>
          </section>
        ) : null}
        {others.length > 0 ? (
          <details class="providers" data-part="others" open={needle !== "" || (ready.length === 0 && advised.length === 0) ? true : undefined}>
            <summary>
              {ready.length + advised.length > 0 ? "Other providers" : "All providers"} ({others.length})
            </summary>
            <ul class="plain">{others.map(item)}</ul>
          </details>
        ) : null}
      </div>
    </>
  );
}
