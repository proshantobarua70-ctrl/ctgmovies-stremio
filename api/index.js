
const WORKER =
  "https://ctgmovies-api.proshantobarua70-4a5.workers.dev";

const ADDON_ID = "com.mhthe1.ctgmovies.bridge";
const VERSION = "5.1.0";
const PAGE_SIZE = 100;

function sendJson(res, status, data) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(data);
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

async function workerFetch(path) {
  const response = await fetch(`${WORKER}${path}`, {
    headers: {
      "User-Agent": "CTGMovies-Stremio-Bridge/5.1"
    }
  });

  const body = await response.text();
  let data;

  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`Worker returned invalid JSON (HTTP ${response.status})`);
  }

  if (!response.ok) {
    throw new Error(
      data.error || data.message || `Worker HTTP ${response.status}`
    );
  }

  return data;
}

function parseEpisodes(value) {
  if (Array.isArray(value)) return value;

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

function getType(id, fallback) {
  if (String(id).includes(":tv:") ||
      String(id).includes(":anime:")) {
    return "series";
  }

  return fallback || "movie";
}

function makeManifest() {
  const extra = [
    { name: "search", isRequired: false },
    { name: "skip", isRequired: false }
  ];

  return {
    id: ADDON_ID,
    version: VERSION,
    name: "CTGMovies Bridge",
    description: "CTGMovies catalog, TV shows, anime and streams.",
    logo: "https://dhakastremio.mehedihtanvir.me/icon.svg",
    resources: [
      "catalog",
      {
        name: "meta",
        types: ["movie", "series"],
        idPrefixes: ["ctg:"]
      },
      {
        name: "stream",
        types: ["movie", "series"],
        idPrefixes: ["ctg:"]
      }
    ],
    types: ["movie", "series"],
    catalogs: [
      { type: "movie", id: "ctg_movies", name: "CTGMovies Movies", extra },
      { type: "series", id: "ctg_tv", name: "CTGMovies TV Shows", extra },
      { type: "series", id: "ctg_anime", name: "CTGMovies Anime", extra }
    ],
    behaviorHints: {
      configurable: false,
      configurationRequired: false
    }
  };
}

function convertMeta(item, requestedType, requestedId) {
  const id = item.id || requestedId;
  const type = getType(id, requestedType);
  const meta = {
    id,
    type,
    name: item.name || "CTGMovies"
  };

  if (item.poster) meta.poster = item.poster;
  if (item.backdrop) meta.background = item.backdrop;
  if (item.overview) meta.description = item.overview;
  if (item.year) meta.releaseInfo = String(item.year);
  if (item.rating != null) meta.imdbRating = String(item.rating);
  if (Array.isArray(item.genres)) meta.genres = item.genres;
  if (item.imdb) meta.imdb_id = item.imdb;

  const episodes = parseEpisodes(item.episodes);

  if (type === "series" && episodes.length) {
    meta.videos = episodes
      .filter(ep => ep && Number.isFinite(Number(ep.s)) &&
        Number.isFinite(Number(ep.e)))
      .map(ep => {
        const video = {
          id: `${id}:${Number(ep.s)}:${Number(ep.e)}`,
          title: ep.name || `Episode ${Number(ep.e)}`,
          season: Number(ep.s),
          episode: Number(ep.e)
        };

        if (ep.overview) video.overview = ep.overview;
        if (ep.still) video.thumbnail = ep.still;
        if (ep.air) video.released = `${ep.air}T00:00:00.000Z`;

        return video;
      });
  }

  return { meta };
}

function matchesCatalog(item, catalog) {
  const kind = String(item.kind || "").toLowerCase();

  if (catalog === "ctg_movies") return kind === "movie";
  if (catalog === "ctg_tv") return kind === "tv";
  if (catalog === "ctg_anime") return kind === "anime";

  return false;
}

async function handleCatalog(path, url, res) {
  const parts = path.split("/").filter(Boolean);
  const type = parts[1] || "movie";
  const catalog = cleanId(parts[2] || "");
  const skip = Math.max(0, Number(url.searchParams.get("skip") || 0));
  const search = url.searchParams.get("search") || "";

  if (!["ctg_movies", "ctg_tv", "ctg_anime"].includes(catalog)) {
    return sendJson(res, 200, { metas: [] });
  }

  // Worker data uses page/limit. Filter the returned items by catalog kind.
  const page = Math.floor(skip / PAGE_SIZE) + 1;
  const query = new URLSearchParams({
    page: String(page),
    limit: String(PAGE_SIZE)
  });

  if (search) query.set("search", search);

  const data = await workerFetch(`/movies?${query.toString()}`);
  const items = Array.isArray(data.items) ? data.items : [];

  const metas = items
    .filter(item => matchesCatalog(item, catalog))
    .map(item => ({
      id: item.id,
      type: item.kind === "movie" ? "movie" : "series",
      name: item.name || "CTGMovies",
      ...(item.poster ? { poster: item.poster } : {}),
      ...(item.backdrop ? { background: item.backdrop } : {}),
      ...(item.overview ? { description: item.overview } : {}),
      ...(item.year ? { releaseInfo: String(item.year) } : {})
    }));

  return sendJson(res, 200, { metas });
}

function parseStreamRequest(path, url) {
  const parts = path.split("/").filter(Boolean);
  const index = parts.indexOf("stream");

  let type = "";
  let id = "";
  let season = null;
  let episode = null;

  if (index !== -1) {
    type = parts[index + 1] || "";
    const remaining = parts.slice(index + 2);

    if (remaining.length) {
      id = cleanId(remaining[0]);

      if (remaining.length >= 3) {
        const s = cleanId(remaining[remaining.length - 2]);
        const e = cleanId(remaining[remaining.length - 1]);

        if (/^\d+$/.test(s) && /^\d+$/.test(e)) {
          season = Number(s);
          episode = Number(e);
          id = cleanId(remaining[remaining.length - 3]);
        }
      }

      const bits = id.split(":");
      if (
        bits.length >= 5 &&
        bits[0] === "ctg" &&
        /^\d+$/.test(bits[bits.length - 2]) &&
        /^\d+$/.test(bits[bits.length - 1])
      ) {
        season = Number(bits[bits.length - 2]);
        episode = Number(bits[bits.length - 1]);
        id = bits.slice(0, -2).join(":");
      }
    }
  }

  if (url.searchParams.has("id")) {
    id = cleanId(url.searchParams.get("id"));
  }

  const qs = url.searchParams.get("season");
  const qe = url.searchParams.get("episode");

  if (qs !== null && /^\d+$/.test(qs)) season = Number(qs);
  if (qe !== null && /^\d+$/.test(qe)) episode = Number(qe);

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
        const subtitles = link.subs
          .filter(sub => sub && typeof sub.url === "string" && sub.url)
          .map(sub => ({
            url: sub.url,
            lang: sub.label || "Unknown",
            label: sub.label || "Subtitle"
          }));

        if (subtitles.length) stream.subtitles = subtitles;
      }

      return stream;
    });
}

async function handleStream(path, url, res) {
  const request = parseStreamRequest(path, url);

  if (!request.id) {
    return sendJson(res, 200, { streams: [] });
  }

  const data = await workerFetch(
    `/stream?id=${encodeURIComponent(request.id)}`
  );

  const episodes = parseEpisodes(data.episodes);
  let links = [];

  if (request.type === "movie" || episodes.length === 0) {
    links = Array.isArray(data.links) ? data.links : [];
  } else {
    let selected = null;

    if (request.season !== null && request.episode !== null) {
      selected = episodes.find(ep =>
        Number(ep.s) === request.season &&
        Number(ep.e) === request.episode
      );
    }

    if (!selected && request.episode !== null) {
      selected = episodes.find(ep => Number(ep.e) === request.episode);
    }

    if (selected && Array.isArray(selected.links)) {
      links = selected.links;
    }
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

    if (path === "/") {
      return sendJson(res, 200, {
        ok: true,
        service: "CTGMovies Vercel Bridge",
        version: VERSION,
        manifest: "/manifest.json"
      });
    }

    if (path === "/ping") {
      return sendJson(res, 200, {
        ok: true,
        service: "CTGMovies Vercel Bridge",
        version: VERSION,
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
      const parts = path.split("/").filter(Boolean);
      const id = cleanId(parts[parts.length - 1]);
      const type = getType(id);

      const data = await workerFetch(
        `/stream?id=${encodeURIComponent(id)}`
      );

      return sendJson(res, 200, convertMeta(data, type, id));
    }

    if (path === "/stream" || path.includes("/stream/")) {
      return await handleStream(path, url, res);
    }

    if (path === "/movies" || path === "/search" || path === "/meta") {
      const endpoint = path;
      const data = await workerFetch(`${endpoint}${url.search}`);
      return sendJson(res, 200, data);
    }

    return sendJson(res, 404, {
      error: "Not found",
      path
    });
  } catch (error) {
    console.error("CTGMovies bridge error:", error);

    return sendJson(res, 500, {
      error: "Vercel bridge error",
      message: error.message
    });
  }
};
