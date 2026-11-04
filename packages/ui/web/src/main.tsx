import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Doctor } from "./doctor.tsx";
import { RunView } from "./run.tsx";
import { Settings } from "./settings.tsx";
import { Start } from "./start.tsx";
import "./style.css";

/** The route is the part of the address after `#`: `/`, `/run/ID`, `/run/ID/job/JOB`, `/settings`, `/doctor`. */
function useRoute(): string[] {
  const read = () => location.hash.replace(/^#\/?/, "").split("/").filter((x) => x !== "").map(decodeURIComponent);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

function App() {
  const route = useRoute();
  const [head, id, , job] = route;
  const here = head ?? "";
  return (
    <>
      <header class="bar">
        <a class="brand" href="#/">
          Seshat
        </a>
        <nav aria-label="Main">
          <a href="#/" aria-current={here === "" || here === "run" ? "page" : undefined}>
            Problems
          </a>
          <a href="#/doctor" aria-current={here === "doctor" ? "page" : undefined}>
            Checklist
          </a>
          <a href="#/settings" aria-current={here === "settings" ? "page" : undefined}>
            Providers
          </a>
        </nav>
      </header>
      <main>
        {here === "settings" ? <Settings /> : here === "doctor" ? <Doctor /> : here === "run" && id !== undefined ? <RunView key={id} id={id} jobId={job} /> : <Start />}
      </main>
      <footer>
        <p>
          This page runs on your machine only. It reads the run's journal and starts the same commands you could type. Lean decides what is proved; nothing here can change that.
        </p>
      </footer>
    </>
  );
}

render(<App />, document.getElementById("app") as HTMLElement);
