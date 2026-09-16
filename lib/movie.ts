/**
 * Movie metadata providers — all legitimate public APIs/sources:
 *
 *   tmdb       TMDB v3 API (requires TMDB_API_KEY)          — richest fields
 *   omdb       OMDb API      (requires OMDB_API_KEY)        — IMDb/RT ratings
 *   wikipedia  Public Wikipedia REST + OpenSearch (no key)  — summary fallback
 *
 * "auto" order: tmdb → omdb → wikipedia. No fabricated data is ever returned;
 * a provider miss surfaces as a structured error instead.
 */

import { stealthFetch } from "./fetcher";

export interface MovieMetadata {
  title: string;
  year?: number;
  overview?: string;
  rating?: number;
  ratingSource?: string;
  genres?: string[];
  runtimeMinutes?: number;
  imdbId?: string;
  posterUrl?: string;
  provider: "tmdb" | "omdb" | "wikipedia";
  sourceUrl?: string;
}

export class MovieError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
  ) {
    super(message);
    this.name = "MovieError";
  }
}

const TIMEOUT = 10_000;
const MAX_BYTES = 512 * 1024;

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await stealthFetch({
    url,
    timeoutMs: TIMEOUT,
    maxBytes: MAX_BYTES,
    maxRetries: 1,
    headers: { accept: "application/json" },
  });
  if (res.status !== 200 || !res.bodyText) {
    throw new MovieError(
      `Provider request failed with status ${res.status}`,
      "http",
    );
  }
  return JSON.parse(res.bodyText) as Record<string, unknown>;
}

async function fromTmdb(title: string, year?: number): Promise<MovieMetadata> {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new MovieError("TMDB_API_KEY not configured", "tmdb");

  const q = new URL("https://api.themoviedb.org/3/search/movie");
  q.searchParams.set("api_key", key);
  q.searchParams.set("query", title);
  q.searchParams.set("include_adult", "false");
  if (year) q.searchParams.set("year", String(year));
  const search = await getJson(q.toString());
  const first = (
    search.results as Array<Record<string, unknown>> | undefined
  )?.[0];
  if (!first) throw new MovieError(`No TMDB match for "${title}"`, "tmdb");

  const detail = await getJson(
    `https://api.themoviedb.org/3/movie/${first.id}?api_key=${key}`,
  );
  return {
    title: String(detail.title ?? first.title ?? title),
    year:
      Number(String(detail.release_date ?? "").slice(0, 4)) ||
      Number(String(first.release_date ?? "").slice(0, 4)) ||
      undefined,
    overview: (detail.overview as string) ?? undefined,
    rating: (detail.vote_average as number) ?? undefined,
    ratingSource: "tmdb",
    genres: ((detail.genres as Array<{ name: string }>) ?? []).map(
      (g) => g.name,
    ),
    runtimeMinutes: (detail.runtime as number) ?? undefined,
    imdbId: (detail.imdb_id as string) ?? undefined,
    posterUrl: detail.poster_path
      ? `https://image.tmdb.org/t/p/w500${detail.poster_path}`
      : undefined,
    provider: "tmdb",
    sourceUrl: `https://www.themoviedb.org/movie/${detail.id ?? first.id}`,
  };
}

async function fromOmdb(title: string, year?: number): Promise<MovieMetadata> {
  const key = process.env.OMDB_API_KEY;
  if (!key) throw new MovieError("OMDB_API_KEY not configured", "omdb");

  const q = new URL("https://www.omdbapi.com/");
  q.searchParams.set("apikey", key);
  q.searchParams.set("t", title);
  q.searchParams.set("plot", "short");
  if (year) q.searchParams.set("y", String(year));
  const d = await getJson(q.toString());
  if (d.Response !== "True") {
    throw new MovieError(
      `OMDb lookup failed: ${String(d.Error ?? "unknown")}`,
      "omdb",
    );
  }
  const rt = (d.Ratings as Array<{ Source: string; Value: string }>) ?? [];
  const imdb = rt.find((r) => r.Source === "Internet Movie Database");
  return {
    title: String(d.Title ?? title),
    year: Number(d.Year) || undefined,
    overview: (d.Plot as string) ?? undefined,
    rating: imdb ? Number.parseFloat(imdb.Value) : undefined,
    ratingSource: imdb ? "imdb" : undefined,
    genres: String(d.Genre ?? "")
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean),
    runtimeMinutes: Number.parseInt(String(d.Runtime ?? ""), 10) || undefined,
    imdbId: (d.imdbID as string) ?? undefined,
    posterUrl: (d.Poster as string) || undefined,
    provider: "omdb",
    sourceUrl: d.imdbID
      ? `https://www.imdb.com/title/${d.imdbID}/`
      : undefined,
  };
}

async function fromWikipedia(
  title: string,
  year?: number,
): Promise<MovieMetadata> {
  const queries = [
    `${title} film${year ? ` ${year}` : ""}`,
    `${title} film`,
    title,
  ];

  // Gather candidates across queries; score: year-exact film disambiguation >
  // any "(film)" title > title-prefix match > generic film mention.
  const seen = new Set<string>();
  const candidates: Array<{ t: string; u: string; s: number }> = [];
  const score = (t: string): number => {
    let s = 0;
    if (year && t.includes(`(${year} film)`)) s += 8;
    if (/\((\d{4} )?film\)/.test(t)) s += 4;
    if (t.toLowerCase().startsWith(title.toLowerCase())) s += 2;
    if (/film/i.test(t)) s += 1;
    return s;
  };
  for (const term of queries) {
    const q = new URL("https://en.wikipedia.org/w/api.php");
    q.searchParams.set("action", "opensearch");
    q.searchParams.set("search", term);
    q.searchParams.set("limit", "5");
    q.searchParams.set("namespace", "0");
    q.searchParams.set("format", "json");
    q.searchParams.set("origin", "*");

    const res = await stealthFetch({
      url: q.toString(),
      timeoutMs: TIMEOUT,
      maxBytes: MAX_BYTES,
      maxRetries: 1,
    });
    if (res.status !== 200 || !res.bodyText) continue;
    const [, titles, , urls] = JSON.parse(res.bodyText) as [
      string,
      string[],
      string[],
      string[],
    ];
    titles.forEach((t, i) => {
      if (seen.has(t)) return;
      seen.add(t);
      candidates.push({ t, u: urls[i] ?? "", s: score(t) });
    });
  }
  candidates.sort((a, b) => b.s - a.s);

  // Try candidates in score order; skip disambiguation pages — a film title
  // query that resolves to "(disambiguation)" means we picked the wrong page.
  for (const cand of candidates.slice(0, 4)) {
    try {
      const summary = await getJson(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cand.t)}`,
      );
      if (summary.type === "disambiguation") continue;
      const extract = (summary.extract as string) ?? "";
      if (!extract) continue;
      const yearMatch = /\b(19|20)\d{2}\b/.exec(
        String(summary.description ?? ""),
      );
      return {
        title: String(summary.title ?? cand.t),
        year: year ?? (yearMatch ? Number(yearMatch[0]) : undefined),
        overview: extract,
        provider: "wikipedia",
        sourceUrl:
          ((summary.content_urls as Record<string, { page?: string }>)?.desktop
            ?.page as string) ?? cand.u,
        posterUrl:
          (summary.originalimage as { source?: string })?.source ?? undefined,
      };
    } catch {
      continue;
    }
  }
  throw new MovieError(`No Wikipedia article for "${title}"`, "wikipedia");
}

const PROVIDERS = {
  tmdb: fromTmdb,
  omdb: fromOmdb,
  wikipedia: fromWikipedia,
} as const;

export async function getMovieMetadata(
  title: string,
  year: number | undefined,
  provider: "auto" | keyof typeof PROVIDERS,
): Promise<MovieMetadata> {
  if (provider !== "auto") {
    return PROVIDERS[provider](title, year);
  }
  const errors: string[] = [];
  for (const name of ["tmdb", "omdb", "wikipedia"] as const) {
    try {
      return await PROVIDERS[name](title, year);
    } catch (err) {
      errors.push(
        `${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  throw new MovieError(
    `All providers failed — ${errors.join("; ")}`,
    "auto",
  );
}
