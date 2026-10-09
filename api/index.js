
const WORKER =
  "https://ctgmovies-api.proshantobarua70-4a5.workers.dev";

const ADDON_ID = "com.mhthe1.ctgmovies.bridge";

/* =========================
   HELPERS
========================= */

function cleanId(value) {
  let result = String(value || "").trim();

  try {
    result = decodeURIComponent(result);
  } catch {}

  return result.replace(/\.json$/i, "").trim();
}

function sendJson(res, status, data) {
  res.status(status);
  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );
  return res.json(data);
}

async function workerFetch(path) {
  const response = await fetch(`${WORKER}${path}`, {
    headers: {
      "User-Agent": "CTGMovies-Stremio-Bridge/5.0"
    }
  });

  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Worker returned invalid JSON: HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(
      data.error ||
      data.message ||
      `Worker HTTP ${response.status}`
    );
  }

  return data;
}

/* =========================
   MANIFEST
========================= */

function makeManifest() {
  return {
    id: ADDON_ID,
    version: "5.0.0",
    name: "CTGMovies Bridge",

    description:
      "CTGMovies Movies, TV Shows and Anime with direct streams.",

    logo:
      "https://dhakastremio.mehedihtanvir.me/icon.svg",

    background:
      "https://images.unsplash.com/photo-1574375927938-d5a98e8ffe85?q=80&w=1920&auto=format&fit=crop",

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

/* =========================
   META CONVERTER
========================= */

function convertMeta(data, type, id) {
  const actualId = data.id || id;

  const actualType =
    type ||
    (
      String(actualId).includes(":tv:") ||
      String(actualId).includes(":anime:")
        ? "series"
        : "movie"
    );

  const meta = {
    id: actualId,
    type: actualType,
    name: data.name || "CTGMovies"
  };

  if (data.poster) meta.poster = data.poster;
  if (data.backdrop) meta.background = data.backdrop;
  if (data.overview) meta.description = data.overview;
  if (data.year) meta.releaseInfo = String(data.year);
  if (data.rating) meta.imdbRating = data.rating;
  if (Array.isArray(data.genres)) meta.genres = data.genres;
  if (data.imdb) meta.imdb_id = data.imdb;

  if (
    actualType === "series" &&
    Array.isArray(data.episodes)
  ) {
    meta.videos = data.episodes
      .filter(ep =>
        ep &&
        Number.isFinite(Number(ep.s)) &&
        Number.isFinite(Number(ep.e))
      )
      .map(ep => {
        const video = {
          id: `${actualId}:${Number(ep.s)}:${Number(ep.e)}`,
          title: ep.name || `Episode ${Number(ep.e)}`,
          season: Number(ep.s),
          episode: Number(ep.e)
        };

        if (ep.overview) video.overview = ep.overview;
        if (ep.still) video.thumbnail = ep.still;

        if (ep.air) {
          video.released = `${ep.air}T00:00:00.000Z`;
        }

        return video;
      });
  }

  return { meta };
}

/* =========================
   CATALOG HANDLER
========================= */

async function handleCatalog(path, url, res) {
  const parts = path.split("/").filter(Boolean);

  const type = parts[1] || "movie";
  const catalog = cleanId(parts[2] || "");

  const skip = Math.max(
    0,
    Number(url.searchParams.get("skip") || "0") || 0
  );

  const search = url.searchParams.get("search") || "";

  let target =
    `/movies?type=${encodeURIComponent(type)}` +
    `&catalog=${encodeURIComponent(catalog)}` +
    `&skip=${encodeURIComponent(skip)}`;

  if (search) {
    target += `&search=${encodeURIComponent(search)}`;
  }

  const data = await workerFetch(target);

  if (Array.isArray(data.metas)) {
    return sendJson(res, 200, {
      metas: data.metas
    });
  }

  if (Array.isArray(data.items)) {
    const metas = data.items.map(item => ({
      id: item.id,
      type:
        item.kind === "movie" ? "movie" : "series",
      name: item.name,
      poster: item.poster,
      background: item.backdrop,
      description: item.overview,
      releaseInfo: item.year
        ? String(item.year)
        : undefined
    }));

    return sendJson(res, 200, { metas });
  }

  return sendJson(res, 200, { metas: [] });
}

/* =========================
   STREAM ID PARSER
========================= */

function parseStreamRequest(pathname, url) {
  const parts = pathname.split("/").filter(Boolean);

  let type = "";
  let id = "";
  let season = null;
  let episode = null;

  const streamIndex = parts.indexOf("stream");

  if (streamIndex === -1) {
    return { type, id, season, episode };
  }

  type = parts[streamIndex + 1] || "";

  const remaining = parts.slice(streamIndex + 2);

  if (remaining.length > 0) {
    id = cleanId(remaining[0]);

    // Supports /stream/series/ID/1/1.json
    if (remaining.length >= 3) {
      const s = cleanId(
        remaining[remaining.length - 2]
      );

      const e = cleanId(
        remaining[remaining.length - 1]
      );

      if (/^\d+$/.test(s) && /^\d+$/.test(e)) {
        season = Number(s);
        episode = Number(e);

        id = cleanId(
          remaining[remaining.length - 3]
        );
      }
    }

    // Supports episode IDs such as ctg:tv:name:1:1
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
  }

  // Query parameters override the parsed values.
  const queryId = url.searchParams.get("id");

  if (queryId) {
    id = cleanId(queryId);
  }

  const querySeason = url.searchParams.get("season");
  const queryEpisode = url.searchParams.get("episode");

  if (
    querySeason !== null &&
    /^\d+$/.test(querySeason)
  ) {
    season = Number(querySeason);
  }

  if (
    queryEpisode !== null &&
    /^\d+$/.test(queryEpisode)
  ) {
    episode = Number(queryEpisode);
  }

  return { type, id, season, episode };
}

/* =========================
   STREAM CONVERTER
========================= */

function makeStreams(links) {
  if (!Array.isArray(links)) return [];

  return links
    .filter(link =>
      link &&
      typeof link.url === "string" &&
      link.url.length > 0
    )
    .map(link => {
      const subtitles = Array.isArray(link.subs)
        ? link.subs
            .filter(sub =>
              sub &&
              typeof sub.url === "string" &&
              sub.url.length > 0
            )
            .map(sub => ({
              url: sub.url,
              lang: sub.label || "Unknown",
              label: sub.label || "Subtitle"
            }))
        : [];

      const stream = {
        name: "CTGMovies",
        title:
          `${link.quality || "Direct"}` +
          (link.source ? ` • ${link.source}` : ""),
        url: link.url,
        behaviorHints: {
          bingeGroup: "ctgmovies"
        }
      };

      if (subtitles.length > 0) {
        stream.subtitles = subtitles;
      }

      return stream;
    });
}

/* =========================
   STREAM HANDLER
========================= */

async function handleStream(path, url, res) {
  const request = parseStreamRequest(path, url);

  if (!request.id) {
    return sendJson(res, 200, { streams: [] });
  }

  const data = await workerFetch(
    `/stream?id=${encodeURIComponent(request.id)}`
  );

  let links = [];

  // Movies
  if (
    request.type === "movie" ||
    !Array.isArray(data.episodes)
  ) {
    if (Array.isArray(data.links)) {
      links = data.links;
    }
  } else {
    // Series and anime
    let selected = null;

    if (
      request.season !== null &&
      request.episode !== null
    ) {
      selected = data.episodes.find(ep =>
        Number(ep.s) === request.season &&
        Number(ep.e) === request.episode
      );
    }

    // Fallback to episode number if season is unavailable.
    if (!selected && request.episode !== null) {
      selected = data.episodes.find(ep =>
        Number(ep.e) === request.episode
      );
    }

    if (selected && Array.isArray(selected.links)) {
      links = selected.links;
    }
  }

  return sendJson(res, 200, {
    streams: makeStreams(links)
  });
}

/* =========================
   MAIN VERCEL HANDLER
========================= */

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    const url = new URL(
      req.url,
      `https://${req.headers.host || "localhost"}`
    );

    const path = url.pathname;

    // PING
    if (path === "/ping") {
      return sendJson(res, 200, {
        ok: true,
        service: "CTGMovies Vercel Bridge",
        version: "5.0.0",
        worker: WORKER
      });
    }

    // MANIFEST
    if (path === "/manifest.json") {
      return sendJson(res, 200, makeManifest());
    }

    // CATALOG
    if (path.includes("/catalog/")) {
      return await handleCatalog(path, url, res);
    }

    // META
    if (path.includes("/meta/")) {
      const parts = path.split("/").filter(Boolean);
      const id = cleanId(parts[parts.length - 1]);

      const type =
        id.includes(":tv:") ||
        id.includes(":anime:")
          ? "series"
          : "movie";

      const data = await workerFetch(
        `/stream?id=${encodeURIComponent(id)}`
      );

      return sendJson(
        res,
        200,
        convertMeta(data, type, id)
      );
    }

    // STREAM
    if (
      path === "/stream" ||
      path.includes("/stream/")
    ) {
      return await handleStream(path, url, res);
    }

    // DIRECT MOVIES API
    if (path === "/movies") {
      const data = await workerFetch(
        `/movies${url.search}`
      );

      return sendJson(res, 200, data);
    }

    // DIRECT SEARCH API
    if (path === "/search") {
      const data = await workerFetch(
        `/search${url.search}`
      );

      return sendJson(res, 200, data);
    }

    // DIRECT META API
    if (path === "/meta") {
      const id = url.searchParams.get("id") || "";

      const data = await workerFetch(
        `/meta?id=${encodeURIComponent(id)}`
      );

      return sendJson(res, 200, data);
    }

    return sendJson(res, 404, {
      error: "Not found",
      path
    });
  } catch (error) {
    console.error("CTGMovies bridge error:", error);

    return sendJson(res, 500, {
      streams: [],
      error: "Vercel bridge error",
      message: error.message
    });
  }
};
