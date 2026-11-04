import { Component, type ComponentChildren, render } from "preact";
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

/** A screen that cannot draw what it was given shows one plain line instead of a blank page. */
class Guard extends Component<{ children?: ComponentChildren }, { failed: boolean }> {
  state = { failed: false };
  componentDidCatch() {
    this.setState({ failed: true });
  }
  render() {
    return this.state.failed ? (
      <p class="notice" role="alert">
        This screen could not be drawn from what the server sent. Reload the page; the journal is untouched.
      </p>
    ) : (
      this.props.children
    );
  }
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
        <Guard key={route.join("/")}>
        {here === "settings" ? <Settings /> : here === "doctor" ? <Doctor /> : here === "run" && id !== undefined ? <RunView key={id} id={id} jobId={job} /> : <Start />}
        </Guard>
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
