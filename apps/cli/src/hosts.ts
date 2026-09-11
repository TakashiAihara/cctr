import { HttpSource, LocalSource, MultiSource, SshSource, type Source } from "@cctr/core";
import { loadRemotes, type Remote } from "./config";
import { CliError } from "./output";
import { VERSION } from "./version";

export function localSource(): LocalSource {
  return new LocalSource({ version: VERSION });
}

export function remoteSource(name: string, r: Remote): Source {
  return r.kind === "http"
    ? new HttpSource({ host: name, url: r.url, token: r.token })
    : new SshSource({ host: name, target: r.target, command: r.command });
}

/**
 * `--host local` (default) reads this machine's files; `--host <name>` one
 * remote; `--host all` this machine plus every remote; a comma list picks some.
 */
export function resolveHosts(spec: string | undefined): MultiSource {
  const remotes = loadRemotes();
  const names = (spec ?? "local")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const sources: Source[] = [];
  for (const n of names) {
    if (n === "local") sources.push(localSource());
    else if (n === "all") {
      sources.push(localSource(), ...Object.entries(remotes).map(([name, r]) => remoteSource(name, r)));
    } else {
      const r = remotes[n];
      if (!r)
        throw new CliError(
          `unknown host: ${n} (known: local, all${Object.keys(remotes)
            .map((k) => `, ${k}`)
            .join("")})`,
          2,
        );
      sources.push(remoteSource(n, r));
    }
  }
  // dedupe by host name (e.g. `--host all,local`)
  const seen = new Set<string>();
  return new MultiSource(sources.filter((s) => (seen.has(s.host) ? false : (seen.add(s.host), true))));
}

/** `host:id` addresses one host without `--host`; an explicit `--host` still wins. */
export function hostOf(hostOpt: string | undefined, id: string): string | undefined {
  if (hostOpt) return hostOpt;
  const i = id.indexOf(":");
  return i > 0 ? id.slice(0, i) : undefined;
}
