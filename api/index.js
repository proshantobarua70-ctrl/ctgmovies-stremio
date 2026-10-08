const WORKER = "https://ctgmovies-api.proshantobarua70-4a5.workers.dev";

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const path = url.pathname;

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");

    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    // Health
    if (path === "/ping") {
      return res.status(200).json({
        ok: true,
        service: "CTGMovies Vercel Bridge",
        worker: WORKER
      });
    }

    // Manifest
    if (path === "/manifest.json") {
      return res.status(200).json({
        id: "com.mhthe1.ctgmovies.bridge",
        version: "2.0.0",
        name: "CTGMovies Bridge",
        description:
          "High-speed ISP/BDIX direct streams for Movies, TV Shows and Anime from CTGMovies.",
        logo: "https://dhakastremio.mehedihtanvir.me/icon.svg",
        background:
          "https://images.unsplash.com/photo-1574375927938-d5a98e8ffe85?q=80&w=1920&auto=format&fit=crop",
        contactEmail: "mhthe1.dev@gmail.com",

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
            idPrefixes: ["ctg:", "tt"]
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
      });
    }

    // Forward request to Cloudflare Worker
    let target = "";

    // Catalog
    if (path.includes("/catalog/")) {
      const parts = path.split("/").filter(Boolean);

      // /api/catalog/movie/ctg_movies.json
      // /api/catalog/series/ctg_tv.json
      const type = parts[1];
      const catalogId = parts[2]
        ? parts[2].replace(/\.json$/, "")
        : "";

      const skip = url.searchParams.get("skip") || "0";
      const search = url.searchParams.get("search") || "";

      target =
        `${WORKER}/movies?type=${encodeURIComponent(type)}` +
        `&catalog=${encodeURIComponent(catalogId)}` +
        `&skip=${encodeURIComponent(skip)}`;

      if (search) {
        target += `&search=${encodeURIComponent(search)}`;
      }
    }

    // Meta
    else if (path.includes("/meta/")) {
      const parts = path.split("/").filter(Boolean);
      const id = parts[parts.length - 1].replace(/\.json$/, "");

      target = `${WORKER}/meta?id=${encodeURIComponent(id)}`;
    }

    // Stream
    else if (path.includes("/stream/")) {
      const parts = path.split("/").filter(Boolean);
      const id = parts[parts.length - 1].replace(/\.json$/, "");

      target = `${WORKER}/stream?id=${encodeURIComponent(id)}`;
    }

    // Direct API passthrough
    else if (path === "/movies") {
      target = `${WORKER}/movies${url.search}`;
    }

    else if (path === "/search") {
      target = `${WORKER}/search${url.search}`;
    }

    else if (path === "/meta") {
      target = `${WORKER}/meta${url.search}`;
    }

    else if (path === "/stream") {
      target = `${WORKER}/stream${url.search}`;
    }

    else {
      return res.status(404).json({
        error: "Not found"
      });
    }

    const response = await fetch(target, {
      headers: {
        "User-Agent": "CTGMovies-Vercel-Bridge/2.0"
      }
    });

    const text = await response.text();

    res.status(response.status);

    try {
      return res.json(JSON.parse(text));
    } catch {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.send(text);
    }
  } catch (error) {
    return res.status(500).json({
      error: "Vercel bridge error",
      message: error.message
    });
  }
};
