import { useEffect, useState } from "preact/hooks";
import { del, get, message, put, type Provider } from "./api.ts";
import { Notice, Section } from "./ui.tsx";

interface Session {
  keyFile: { path: string; ok: boolean; problem?: string };
}

/** The providers of the library, as it lists them now, and a place to keep each one's key. A saved key is never shown again. */
export function Settings() {
  const [providers, setProviders] = useState<Provider[] | undefined>();
  const [session, setSession] = useState<Session | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [open, setOpen] = useState<string | undefined>();
  const [key, setKey] = useState("");
  const [filter, setFilter] = useState("");

  const load = () => {
    get<{ providers: Provider[] }>("/api/providers").then((r) => setProviders(r.providers), (e) => setError(message(e)));
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

  const shown = (providers ?? []).filter((p) => filter === "" || p.id.includes(filter.toLowerCase()) || p.name.toLowerCase().includes(filter.toLowerCase()));
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
        <ul class="plain">
          {shown.map((p) => (
            <li key={p.id}>
              <div class="row">
                <div>
                  <strong>{p.name}</strong> <code class="muted">{p.id}</code>
                  <div class="small muted">
                    {p.models} model(s). {p.configured ? `Credentials found: ${p.source ?? "yes"}.` : "No credentials."}
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
          ))}
        </ul>
      </div>
    </>
  );
}
