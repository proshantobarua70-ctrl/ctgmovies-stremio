
const WORKER = "https://ctgmovies-api.proshantobarua70-4a5.workers.dev";
const ADDON_ID = "com.mhthe1.ctgmovies.bridge";
const PAGE_SIZE = 100;
const MAX_PAGES = 3;

function sendJson(res, status, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(status).json(data);
}

function cleanId(value) {
  try {
    return decodeURIComponent(String(value || ""))
      .replace(/\.json$/i, "")
      .trim();
  } catch {
    return String(value || "").replace(/\.json$/i, "").trim();
  }
}

function parseEpisodes(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {}
  }
  return [];
}

async function workerFetch(path) {
  const response = await fetch(`${WORKER}${path}`, {
    headers: { "User-Agent": "CTGMovies-Stremio-Bridge/6.0" },
    signal: AbortSignal.timeout(9000)
  });

  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Worker returned invalid JSON: HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(data.error || `Worker HTTP ${response.status}`);
  }

  return data;
}

function makeManifest() {
  return {
    id: ADDON_ID,
    version: "6.0.0",
    name: "CTGMovies Bridge",
    description: "CTGMovies catalog and metadata bridge",
    resources: [
      "catalog",
      { name: "meta", types: ["movie", "series"], idPrefixes: ["ctg:"] },
      { name: "stream", types: ["movie", "series"], idPrefixes: ["ctg:"] }
    ],
    types: ["movie", "series"],
    catalogs: [
      {
        type: "movie",
        id: "ctg_movies",
        name: "CTGMovies Movies",
        extra: [
          { name: "search", isRequired: false },
          { name: "skip", isRequired: false }
        ]
      },
      {
        type: "series",
        id: "ctg_tv",
        name: "CTGMovies TV Shows",
        extra: [
          { name: "search", isRequired: false },
          { name: "skip", isRequired: false }
        ]
      },
      {
        type: "series",
        id: "ctg_anime",
        name: "CTGMovies Anime",
        extra: [
          { name: "search", isRequired: false },
          { name: "skip", isRequired: false }
        ]
      }
    ],
    behaviorHints: {
      configurable: false,
      configurationRequired: false
    }
  };
}

function catalogType(item, catalog) {
  if (catalog === "ctg_anime") return item.kind === "anime";
  if (catalog === "ctg_tv") return item.kind === "tv";
  return item.kind === "movie";
}

function toCatalogMeta(item) {
  const meta = {
    id: item.id,
    type: item.kind === "movie" ? "movie" : "series",
    name: item.name || "Unknown",
    poster: item.poster || undefined,
    background: item.backdrop || undefined,
    description: item.overview || undefined,
    releaseInfo: item.year ? String(item.year) : undefined
  };

  const genres = item.genres;
  if (Array.isArray(genres)) meta.genres = genres;
  else if (typeof genres === "string") {
    try {
      const parsed = JSON.parse(genres);
      if (Array.isArray(parsed)) meta.genres = parsed;
    } catch {}
  }

  if (item.rating != null) meta.imdbRating = String(item.rating);
  return meta;
}

async function getItems() {
  // Bounded parallel requests: never loop through the entire catalog.
  const results = await Promise.allSettled(
    Array.from({ length: MAX_PAGES }, (_, i) =>
      workerFetch(`/movies?page=${i + 1}&limit=${PAGE_SIZE}`)
    )
  );

  const items = [];
  const seen = new Set();

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const batch = result.value.items;
    if (!Array.isArray(batch)) continue;

    for (const item of batch) {
      if (!item || !item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }

  return items;
}

async function handleCatalog(path, url, res) {
  const parts = path.split("/").filter(Boolean);
  const type = parts[1] || "movie";
  const catalog = cleanId(parts[2] || "");
  const skip = Math.max(0, Number(url.searchParams.get("skip") || 0));
  const search = String(url.searchParams.get("search") || "").trim().toLowerCase();

  let items = await getItems();

  items = items.filter(item => catalogType(item, catalog));

  if (search) {
    items = items.filter(item =>
      String(item.name || "").toLowerCase().includes(search)
    );
  }

  const metas = items
    .slice(skip, skip + PAGE_SIZE)
    .map(toCatalogMeta)
    .filter(meta => meta.type === type);

  return sendJson(res, 200, { metas });
}

function convertMeta(data, id) {
  const actualId = data.id || id;
  const type =
    actualId.includes(":tv:") || actualId.includes(":anime:")
      ? "series"
      : "movie";

  const meta = {
    id: actualId,
    type,
    name: data.name || "CTGMovies"
  };

  if (data.poster) meta.poster = data.poster;
  if (data.backdrop) meta.background = data.backdrop;
  if (data.overview) meta.description = data.overview;
  if (data.year) meta.releaseInfo = String(data.year);
  if (data.rating != null) meta.imdbRating = String(data.rating);

  let genres = data.genres;
  if (typeof genres === "string") {
    try { genres = JSON.parse(genres); } catch { genres = []; }
  }
  if (Array.isArray(genres)) meta.genres = genres;

  const episodes = parseEpisodes(data.episodes);
  if (type === "series") {
    meta.videos = episodes
      .filter(ep => Number.isFinite(Number(ep.s)) && Number.isFinite(Number(ep.e)))
      .map(ep => ({
        id: `${actualId}:${Number(ep.s)}:${Number(ep.e)}`,
        title: ep.name || `Episode ${Number(ep.e)}`,
        season: Number(ep.s),
        episode: Number(ep.e),
        ...(ep.overview ? { overview: ep.overview } : {}),
        ...(ep.still ? { thumbnail: ep.still } : {}),
        ...(ep.air ? { released: `${ep.air}T00:00:00.000Z` } : {})
      }));
  }

  return { meta };
}

function parseStreamRequest(path, url) {
  const parts = path.split("/").filter(Boolean);
  const index = parts.indexOf("stream");
  const type = index >= 0 ? parts[index + 1] || "" : "";
  let id = cleanId(parts[index + 2] || "");
  let season = null;
  let episode = null;

  const colon = id.split(":");
  if (
    colon.length >= 5 &&
    colon[0] === "ctg" &&
    /^\d+$/.test(colon[colon.length - 2]) &&
    /^\d+$/.test(colon[colon.length - 1])
  ) {
    season = Number(colon[colon.length - 2]);
    episode = Number(colon[colon.length - 1]);
    id = colon.slice(0, -2).join(":");
  }

  if (url.searchParams.has("id")) id = cleanId(url.searchParams.get("id"));
  if (/^\d+$/.test(url.searchParams.get("season") || "")) {
    season = Number(url.searchParams.get("season"));
  }
  if (/^\d+$/.test(url.searchParams.get("episode") || "")) {
    episode = Number(url.searchParams.get("episode"));
  }

  return { type, id, season, episode };
}

function makeStreams(links) {
  if (!Array.isArray(links)) return [];

  return links
    .filter(link => link && typeof link.url === "string" && link.url)
    .map(link => {
      const stream = {
        name: "CTGMovies",
        title: `${link.quality || "Direct"}${link.source ? ` • ${link.source}` : ""}`,
        url: link.url,
        behaviorHints: { bingeGroup: "ctgmovies" }
      };

      if (Array.isArray(link.subs)) {
        stream.subtitles = link.subs
          .filter(sub => sub && sub.url)
          .map(sub => ({
            url: sub.url,
            lang: sub.label || "Unknown",
            label: sub.label || "Subtitle"
          }));
      }
      return stream;
    });
}

async function handleStream(path, url, res) {
  const request = parseStreamRequest(path, url);
  if (!request.id) return sendJson(res, 200, { streams: [] });

  const data = await workerFetch(`/stream?id=${encodeURIComponent(request.id)}`);
  const episodes = parseEpisodes(data.episodes);
  let links = [];

  if (request.type === "movie" || episodes.length === 0) {
    links = Array.isArray(data.links) ? data.links : [];
  } else {
    const selected = episodes.find(ep =>
      Number(ep.s) === request.season &&
      Number(ep.e) === request.episode
    );
    links = selected && Array.isArray(selected.links) ? selected.links : [];
  }

  return sendJson(res, 200, { streams: makeStreams(links) });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const path = url.pathname;

    if (path === "/ping") {
      return sendJson(res, 200, {
        ok: true,
        service: "CTGMovies Vercel Bridge",
        version: "6.0.0",
        worker: WORKER
      });
    }

    if (path === "/manifest.json") {
      return sendJson(res, 200, makeManifest());
    }

    if (path.includes("/catalog/")) {
      return await handleCatalog(path, url, res);
    }

    if (path.includes("/meta/")) {
      const id = cleanId(path.split("/").filter(Boolean).pop());
      const data = await workerFetch(`/stream?id=${encodeURIComponent(id)}`);
      return sendJson(res, 200, convertMeta(data, id));
    }

    if (path === "/stream" || path.includes("/stream/")) {
      return await handleStream(path, url, res);
    }

    if (path === "/movies" || path === "/search" || path === "/meta") {
      const endpoint = path;
      const data = await workerFetch(`${endpoint}${url.search}`);
      return sendJson(res, 200, data);
    }

    return sendJson(res, 404, { error: "Not found", path });
  } catch (error) {
    console.error("CTGMovies bridge error:", error);
    return sendJson(res, 502, {
      error: "Worker request failed",
      message: error.message,
      streams: [],
      metas: []
    });
  }
};
