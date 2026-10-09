
const WORKER =
  "https://ctgmovies-api.proshantobarua70-4a5.workers.dev";

const ADDON_ID = "com.mhthe1.ctgmovies.bridge";
const VERSION = "5.2.0";
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

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
      "User-Agent": "CTGMovies-Stremio-Bridge/5.2"
    }
  });

  const body = await response.text();

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(
      `Worker returned invalid JSON (HTTP ${response.status})`
    );
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

function getItems(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.metas)) return data.metas;
  return [];
}

function getKind(item) {
  return String(item?.kind || item?.type || "").toLowerCase();
}

function getType(id, fallback = "movie") {
  const value = String(id || "").toLowerCase();

  if (value.includes(":tv:") || value.includes(":anime:")) {
    return "series";
  }

  return fallback;
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
    description: "CTGMovies catalog, TV shows, anime and metadata.",
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
      {
        type: "movie",
        id: "ctg_movies",
        name: "CTGMovies Movies",
        extra
      },
      {
        type: "series",
        id: "ctg_tv",
        name: "CTGMovies TV Shows",
        extra
      },
      {
        type: "series",
        id: "ctg_anime",
        name: "CTGMovies Anime",
        extra
      }
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
    name: item.name || item.title || "CTGMovies"
  };

  if (item.poster) meta.poster = item.poster;
  if (item.backdrop) meta.background = item.backdrop;
  if (item.overview || item.description) {
    meta.description = item.overview || item.description;
  }
  if (item.year) meta.releaseInfo = String(item.year);
  if (item.rating != null) meta.imdbRating = String(item.rating);
  if (Array.isArray(item.genres)) meta.genres = item.genres;
  if (item.imdb) meta.imdb_id = item.imdb;

  const episodes = parseEpisodes(item.episodes);

  if (type === "series" && episodes.length) {
    meta.videos = episodes
      .filter(ep =>
        ep &&
        Number.isFinite(Number(ep.s)) &&
        Number.isFinite(Number(ep.e))
      )
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
  const kind = getKind(item);

  if (catalog === "ctg_movies") return kind === "movie";
  if (catalog === "ctg_tv") return kind === "tv";
  if (catalog === "ctg_anime") return kind === "anime";

  return false;
}

function toCatalogMeta(item, catalog) {
  const id = item.id;
  if (!id) return null;

  return {
    id,
    type: catalog === "ctg_movies" ? "movie" : "series",
    name: item.name || item.title || "CTGMovies",
    ...(item.poster ? { poster: item.poster } : {}),
    ...(item.backdrop ? { background: item.backdrop } : {}),
    ...(item.overview || item.description
      ? { description: item.overview || item.description }
      : {}),
    ...(item.year ? { releaseInfo: String(item.year) } : {}),
    ...(item.rating != null
      ? { imdbRating: String(item.rating) }
      : {})
  };
}

async function fetchCatalogPage(page, kind, search, useType) {
  const query = new URLSearchParams({
    page: String(page),
    limit: String(PAGE_SIZE)
  });

  if (useType) query.set("type", kind);
  if (search) query.set("search", search);

  return workerFetch(`/movies?${query.toString()}`);
}

async function handleCatalog(path, url, res) {
  const parts = path.split("/").filter(Boolean);
  const catalog = cleanId(parts[2] || "");

  const skip = Math.max(
    0,
    Number(url.searchParams.get("skip") || 0)
  );

  const search = (url.searchParams.get("search") || "")
    .trim()
    .toLowerCase();

  const kindByCatalog = {
    ctg_movies: "movie",
    ctg_tv: "tv",
    ctg_anime: "anime"
  };

  const wantedKind = kindByCatalog[catalog];

  if (!wantedKind) {
    return sendJson(res, 200, { metas: [] });
  }

  const target = skip + PAGE_SIZE;
  const results = [];
  const seenIds = new Set();
  const seenPages = new Set();

  let useType = true;

  for (let page = 1; page <= MAX_PAGES; page++) {
    let data = await fetchCatalogPage(
      page,
      wantedKind,
      search,
      useType
    );

    let items = getItems(data);

    // If type filtering returns no items, retry without that filter.
    if (page === 1 && items.length === 0 && useType) {
      useType = false;
      data = await fetchCatalogPage(page, wantedKind, search, false);
      items = getItems(data);
    }

    // If the type parameter appears to be ignored, use unfiltered pages.
    if (
      page === 1 &&
      useType &&
      items.length > 0 &&
      !items.some(item => matchesCatalog(item, catalog))
    ) {
      useType = false;
      data = await fetchCatalogPage(page, wantedKind, search, false);
      items = getItems(data);
    }

    if (items.length === 0) break;

    // Detect a Worker that ignores page and repeats the same results.
    const signature = items
      .map(item => item.id || item.slug || item.name || "")
      .join("|");

    if (seenPages.has(signature)) break;
    seenPages.add(signature);

    for (const item of items) {
      if (!matchesCatalog(item, catalog)) continue;

      if (
        search &&
        !String(item.name || item.title || "")
          .toLowerCase()
          .includes(search)
      ) {
        continue;
      }

      if (!item.id || seenIds.has(item.id)) continue;
      seenIds.add(item.id);

      const meta = toCatalogMeta(item, catalog);
      if (meta) results.push(meta);

      if (results.length >= target) break;
    }

    if (results.length >= target) break;
    if (items.length < PAGE_SIZE) break;
  }

  return sendJson(res, 200, {
    metas: results.slice(skip, target)
  });
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

      const bits = id.split(":");

      if (
        bits.length >= 5 &&
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
        title: [
          link.quality || "Direct",
          link.source || ""
        ].filter(Boolean).join(" • "),
        url: link.url,
        behaviorHints: {
          bingeGroup: "ctgmovies"
        }
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
  let links = Array.isArray(data.links)
    ? data.links
    : Array.isArray(data.streams)
      ? data.streams
      : [];

  if (
    request.type !== "movie" &&
    episodes.length &&
    request.episode !== null
  ) {
    let selected = episodes.find(ep =>
      Number(ep.s) === request.season &&
      Number(ep.e) === request.episode
    );

    if (!selected) {
      selected = episodes.find(ep =>
        Number(ep.e) === request.episode
      );
    }

    if (selected) {
      if (Array.isArray(selected.links)) {
        links = selected.links;
      } else if (Array.isArray(selected.streams)) {
        links = selected.streams;
      } else {
        links = [];
      }
    } else {
      links = [];
    }
  }

  return sendJson(res, 200, {
    streams: makeStreams(links)
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

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
        `/meta?id=${encodeURIComponent(id)}`
      );

      const item = data.meta || data.item || data;
      return sendJson(res, 200, convertMeta(item, type, id));
    }

    if (path === "/stream" || path.includes("/stream/")) {
      return await handleStream(path, url, res);
    }

    if (
      path === "/movies" ||
      path === "/search" ||
      path === "/meta"
    ) {
      const data = await workerFetch(`${path}${url.search}`);
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
