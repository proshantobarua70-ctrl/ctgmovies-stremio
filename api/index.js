const WORKER =
  "https://ctgmovies-api.proshantobarua70-4a5.workers.dev";

const ADDON_ID = "com.mhthe1.ctgmovies.bridge";

function cleanId(value) {
  return decodeURIComponent(String(value || ""))
    .replace(/\.json$/i, "")
    .trim();
}

function json(res, status, data) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.json(data);
}

function parseStreamRequest(path, url) {
  const parts = path.split("/").filter(Boolean);

  // Expected examples:
  // /stream/movie/ctg:movie:abc.json
  // /stream/series/ctg:tv:abc:1:1.json
  // /stream/series/ctg:tv:abc/1/1.json

  let type = "";
  let id = "";
  let season = null;
  let episode = null;

  const streamIndex = parts.indexOf("stream");

  if (streamIndex >= 0) {
    type = parts[streamIndex + 1] || "";
    const rest = parts.slice(streamIndex + 2);

    if (rest.length) {
      const last = cleanId(rest[rest.length - 1]);

      // Colon format:
      // ctg:tv:east-of-eden:1:1
      const colon = last.split(":");

      if (
        colon.length >= 5 &&
        colon[0] === "ctg" &&
        /^\d+$/.test(colon[colon.length - 2]) &&
        /^\d+$/.test(colon[colon.length - 1])
      ) {
        season = Number(colon[colon.length - 2]);
        episode = Number(colon[colon.length - 1]);

        id = colon.slice(0, -2).join(":");
      } else {
        id = last;

        // Path format:
        // /stream/series/ctg:tv:abc/1/1.json
        if (rest.length >= 3) {
          const s = cleanId(rest[rest.length - 2]);
          const e = cleanId(rest[rest.length - 1]);

          if (/^\d+$/.test(s) && /^\d+$/.test(e)) {
            season = Number(s);
            episode = Number(e);
            id = cleanId(rest[rest.length - 3]);
          }
        }
      }
    }
  }

  // Query fallback
  if (url.searchParams.has("id")) {
    id = cleanId(url.searchParams.get("id"));
  }

  if (url.searchParams.has("season")) {
    season = Number(url.searchParams.get("season"));
  }

  if (url.searchParams.has("episode")) {
    episode = Number(url.searchParams.get("episode"));
  }

  return {
    type,
    id,
    season: Number.isFinite(season) ? season : null,
    episode: Number.isFinite(episode) ? episode : null
  };
}

function makeStreams(links) {
  if (!Array.isArray(links)) return [];

  return links
    .filter(x => x && x.url)
    .map((x, index) => {
      const subtitles = Array.isArray(x.subs)
        ? x.subs
            .filter(s => s && s.url)
            .map(s => ({
              url: s.url,
              lang: s.label || "Unknown",
              label: s.label || "Subtitle"
            }))
        : [];

      return {
        name: "CTGMovies",
        title:
          `${x.quality || "Direct"}`
          + (x.source ? ` • ${x.source}` : ""),
        url: x.url,
        subtitles,
        behaviorHints: {
          bingeGroup: "ctgmovies"
        }
      };
    });
}

async function workerFetch(endpoint) {
  const response = await fetch(`${WORKER}${endpoint}`, {
    headers: {
      "User-Agent": "CTGMovies-Vercel-Bridge/3.0"
    }
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Worker returned invalid JSON (${response.status})`
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

function manifest() {
  return {
    id: ADDON_ID,
    version: "3.0.0",
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
          {
            name: "search",
            isRequired: false
          },
          {
            name: "skip",
            isRequired: false
          }
        ]
      },
      {
        type: "series",
        id: "ctg_tv",
        name: "CTGMovies TV Shows",
        extra: [
          {
            name: "search",
            isRequired: false
          },
          {
            name: "skip",
            isRequired: false
          }
        ]
      },
      {
        type: "series",
        id: "ctg_anime",
        name: "CTGMovies Anime",
        extra: [
          {
            name: "search",
            isRequired: false
          },
          {
            name: "skip",
            isRequired: false
          }
        ]
      }
    ],

    behaviorHints: {
      configurable: false,
      configurationRequired: false
    }
  };
}

function convertMeta(data, type, id) {
  return {
    meta: {
      id: data.id || id,
      type: type || (
        String(data.id || id).includes(":tv:")
          ? "series"
          : "movie"
      ),
      name: data.name || "CTGMovies",
      poster: data.poster || undefined,
      background: data.backdrop || undefined,
      description: data.overview || undefined,
      year: data.year || undefined,
      imdbRating: data.rating || undefined,
      genres: Array.isArray(data.genres)
        ? data.genres
        : typeof data.genres === "string"
          ? data.genres.split(",").map(x => x.trim()).filter(Boolean)
          : undefined,
      runtime: data.runtime || undefined,
      imdb_id: data.imdb || undefined,
      trailers: data.trailer
        ? [{ source: data.trailer, type: "Trailer" }]
        : undefined
    }
  };
}

module.exports = async (req, res) => {
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
      `https://${req.headers.host}`
    );

    const path = url.pathname;

    // -------------------------
    // PING
    // -------------------------
    if (path === "/ping") {
      return json(res, 200, {
        ok: true,
        service: "CTGMovies Vercel Bridge",
        version: "3.0.0",
        worker: WORKER
      });
    }

    // -------------------------
    // MANIFEST
    // -------------------------
    if (path === "/manifest.json") {
      return json(res, 200, manifest());
    }

    // -------------------------
    // CATALOG
    // -------------------------
    if (path.includes("/catalog/")) {
      const parts = path.split("/").filter(Boolean);

      const type = parts[1] || "movie";

      const catalogId = cleanId(
        parts[2] || ""
      );

      const skip = Number(
        url.searchParams.get("skip") || "0"
      );

      const search =
        url.searchParams.get("search") || "";

      let target =
        `/movies?type=${encodeURIComponent(type)}` +
        `&catalog=${encodeURIComponent(catalogId)}` +
        `&skip=${encodeURIComponent(skip)}`;

      if (search) {
        target +=
          `&search=${encodeURIComponent(search)}`;
      }

      const data = await workerFetch(target);

      // Worker already returns metas in the
      // Stremio-compatible catalog shape.
      if (Array.isArray(data.metas)) {
        return json(res, 200, {
          metas: data.metas
        });
      }

      // Fallback if Worker returns items.
      if (Array.isArray(data.items)) {
        const metas = data.items.map(item => ({
          id: item.id,
          type:
            item.kind === "movie"
              ? "movie"
              : "series",
          name: item.name,
          poster: item.poster,
          background: item.backdrop,
          description: item.overview,
          releaseInfo: item.year
            ? String(item.year)
            : undefined
        }));

        return json(res, 200, { metas });
      }

      return json(res, 200, {
        metas: []
      });
    }

    // -------------------------
    // META
    // -------------------------
    if (path.includes("/meta/")) {
      const parts = path.split("/").filter(Boolean);

      const id = cleanId(
        parts[parts.length - 1]
      );

      const data = await workerFetch(
        `/meta?id=${encodeURIComponent(id)}`
      );

      const type =
        String(id).includes(":tv:") ||
        String(id).includes(":anime:")
          ? "series"
          : "movie";

      return json(
        res,
        200,
        convertMeta(data, type, id)
      );
    }

    // -------------------------
    // STREAM
    // -------------------------
    if (path.includes("/stream/") || path === "/stream") {
      const request = parseStreamRequest(
        path,
        url
      );

      if (!request.id) {
        return json(res, 400, {
          streams: [],
          error: "Missing stream id"
        });
      }

      const data = await workerFetch(
        `/stream?id=${encodeURIComponent(
          request.id
        )}`
      );

      let links = [];

      // -------------------------
      // MOVIE
      // -------------------------
      if (
        request.type === "movie" ||
        !Array.isArray(data.episodes)
      ) {
        links = Array.isArray(data.links)
          ? data.links
          : [];
      }

      // -------------------------
      // SERIES / ANIME
      // -------------------------
      else {
        let episode = null;

        if (
          request.season !== null &&
          request.episode !== null
        ) {
          episode = data.episodes.find(
            ep =>
              Number(ep.s) ===
                Number(request.season) &&
              Number(ep.e) ===
                Number(request.episode)
          );
        }

        // If no exact episode was supplied,
        // do not return every episode.
        if (episode) {
          links = Array.isArray(episode.links)
            ? episode.links
            : [];
        }
      }

      const streams = makeStreams(links);

      return json(res, 200, {
        streams
      });
    }

    // -------------------------
    // DIRECT API
    // -------------------------
    if (path === "/movies") {
      const data = await workerFetch(
        `/movies${url.search}`
      );

      return json(res, 200, data);
    }

    if (path === "/search") {
      const data = await workerFetch(
        `/search${url.search}`
      );

      return json(res, 200, data);
    }

    if (path === "/meta") {
      const id =
        url.searchParams.get("id") || "";

      const data = await workerFetch(
        `/meta?id=${encodeURIComponent(id)}`
      );

      return json(res, 200, data);
    }

    if (path === "/stream") {
      const id =
        url.searchParams.get("id") || "";

      const data = await workerFetch(
        `/stream${url.search}`
      );

      return json(res, 200, data);
    }

    return json(res, 404, {
      error: "Not found",
      path
    });

  } catch (error) {
    console.error(error);

    return json(res, 500, {
      streams: [],
      error: "Vercel bridge error",
      message: error.message
    });
  }
};
