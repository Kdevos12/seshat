import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A server that stands in for the OEIS, the LMFDB and FindStat, which this environment cannot reach:
 * it answers the requests of the contract cases of the three capabilities (their `contract.json`)
 * with the answers kept in `fixtures/`, and any other request with the answer of a site that has
 * nothing. The fixtures are written by hand in the shape the sites give (documentation/models.md),
 * not recorded from them.
 */
export interface FakeSite {
  /** `http://127.0.0.1:PORT`. */
  url: string;
  /** Each request that reached it, as `METHOD /path?query`. */
  requests: string[];
  close(): Promise<void>;
}

export interface FakeSiteOptions {
  /** Answers every request with this status instead (a site that is down). */
  status?: number;
  /** Answers every request with this text and a status 200 instead (a site that answers what is not JSON). */
  body?: string;
}

const FIXTURES = new URL("./fixtures/", import.meta.url);
export const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), "utf8");

/** The values of the number of inversions on the permutations of 1, 2 and 3, in the order of the FindStat contract case. */
const INVERSIONS = "0,0,1,0,1,1,2,2,3";

function answer(method: string, url: URL, body: string): string {
  if (method === "GET" && url.pathname === "/search") {
    switch (url.searchParams.get("q")) {
      case "1,1,2,3,5,8,13,21":
        return fixture("oeis-fibonacci.json");
      case "id:A000045":
        return fixture("oeis-a000045-list.json");
      default:
        return fixture("oeis-none.json");
    }
  }
  if (method === "GET" && url.pathname === "/api/nf_fields/") {
    const degree = url.searchParams.get("degree");
    const discriminant = url.searchParams.get("disc_abs");
    if (degree === "2" && discriminant === "5") return fixture("lmfdb-nf-fields.json");
    if (degree === "2" && discriminant === null && url.searchParams.get("_limit") === "3") return fixture("lmfdb-nf-quadratic.json");
    return fixture("lmfdb-none.json");
  }
  if (method === "POST" && url.pathname === "/StatisticFinder/") {
    const { data } = JSON.parse(body) as { data: Array<[unknown, number]> };
    return fixture(data.map(([, value]) => value).join(",") === INVERSIONS ? "findstat-permutations.json" : "findstat-none.json");
  }
  throw new Error(`no answer for ${method} ${url.pathname}`);
}

export async function startFakeSite(options: FakeSiteOptions = {}): Promise<FakeSite> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://fake.test");
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      if (options.status !== undefined) {
        response.statusCode = options.status;
        response.end("down");
        return;
      }
      if (options.body !== undefined) {
        response.end(options.body);
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        response.setHeader("Content-Type", "text/html");
        response.end("<html>the front page</html>");
        return;
      }
      try {
        response.setHeader("Content-Type", "application/json");
        response.end(answer(request.method ?? "GET", url, body));
      } catch (error) {
        response.statusCode = 404;
        response.end(error instanceof Error ? error.message : String(error));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
