const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const app = express();

// CORS middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

const BASEURL = "https://vidsrc.xyz/embed";
const TMDB_API_KEY = process.env.TMDB_API_KEY || "68e094699525b18a70bab2f86b1fa706"; // Set this environment variable
const TMDB_API_BASE = "https://api.themoviedb.org/3";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getHeaders() {
  return {
    "accept": "*/*",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": getRandomUserAgent(),
    "sec-fetch-dest": "iframe",
    "sec-fetch-mode": "no-cors",
    "sec-fetch-site": "same-origin",
  };
}

// Convert TMDB ID to IMDB ID
async function tmdbToImdb(tmdbId, mediaType) {
  if (!TMDB_API_KEY) {
    throw new Error("TMDB_API_KEY environment variable is not set");
  }

  try {
    const endpoint = mediaType === "tv" 
      ? `${TMDB_API_BASE}/tv/${tmdbId}`
      : `${TMDB_API_BASE}/movie/${tmdbId}`;

    const res = await fetch(`${endpoint}?api_key=${TMDB_API_KEY}`);
    const data = await res.json();

    if (!data.external_ids) {
      const externalRes = await fetch(`${endpoint}/external_ids?api_key=${TMDB_API_KEY}`);
      const externalData = await externalRes.json();
      return externalData.imdb_id;
    }

    return data.external_ids.imdb_id;
  } catch (error) {
    throw new Error(`Failed to convert TMDB ID to IMDB ID: ${error.message}`);
  }
}

async function extractRCPData(html, baseDOM) {
  const $ = cheerio.load(html);
  const servers = [];

  $(".serversList .server").each((index, element) => {
    const dataHash = $(element).attr("data-hash");
    if (dataHash) {
      servers.push(dataHash);
    }
  });

  if (servers.length === 0) {
    throw new Error("No servers found");
  }

  const results = [];

  for (const dataHash of servers) {
    try {
      const rcpUrl = `${baseDOM}/rcp/${dataHash}`;
      const rcpRes = await fetch(rcpUrl, { headers: getHeaders() });
      const rcpText = await rcpRes.text();

      const rcpMatch = rcpText.match(/src:\s*'([^']*)'/);
      if (!rcpMatch) continue;

      const prorcpPath = rcpMatch[1].replace("/prorcp/", "");
      const prorcpUrl = `${baseDOM}/prorcp/${prorcpPath}`;

      const prorcpRes = await fetch(prorcpUrl, { headers: getHeaders() });
      const prorcpText = await prorcpRes.text();

      const fileMatch = prorcpText.match(/file:\s*'([^']*)'/);
      if (fileMatch && fileMatch[1]) {
        results.push({
          url: fileMatch[1],
          referer: baseDOM,
        });
      }
    } catch (err) {
      console.error(`Error processing server ${dataHash}:`, err.message);
      continue;
    }
  }

  return results;
}

// Movie route: /movie/:tmdb_id
app.get("/movie/:tmdb_id", async (req, res) => {
  try {
    const { tmdb_id } = req.params;

    if (!tmdb_id) {
      return res.status(400).json({ error: "TMDB ID required" });
    }

    console.log(`Converting TMDB ID ${tmdb_id} to IMDB ID...`);
    const imdbId = await tmdbToImdb(tmdb_id, "movie");

    if (!imdbId) {
      return res.status(404).json({ error: "IMDB ID not found for this TMDB ID" });
    }

    const embedUrl = `${BASEURL}/movie/${imdbId}`;
    console.log(`Fetching movie: ${embedUrl}`);

    const embedRes = await fetch(embedUrl, { headers: getHeaders() });
    const embedHtml = await embedRes.text();

    // Extract base domain from iframe
    const iframeMatch = embedHtml.match(/src="([^"]*)"/);
    let baseDOM = "https://cloudnestra.com";

    if (iframeMatch) {
      const iframeSrc = iframeMatch[1];
      const url = new URL(iframeSrc.startsWith("//") ? "https:" + iframeSrc : iframeSrc);
      baseDOM = `${url.protocol}//${url.host}`;
    }

    const streams = await extractRCPData(embedHtml, baseDOM);

    if (streams.length === 0) {
      return res.status(404).json({ error: "No streams found" });
    }

    res.json({ 
      tmdb_id,
      imdb_id: imdbId,
      type: "movie",
      streams: streams.map(s => ({
        url: `/stream?url=${encodeURIComponent(s.url)}&referer=${encodeURIComponent(s.referer)}`,
        originalUrl: s.url,
        referer: s.referer
      }))
    });
  } catch (error) {
    console.error("Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// TV route: /tv/:tmdb_id/:season/:episode
app.get("/tv/:tmdb_id/:season/:episode", async (req, res) => {
  try {
    const { tmdb_id, season, episode } = req.params;

    if (!tmdb_id || !season || !episode) {
      return res.status(400).json({ error: "TMDB ID, season, and episode required" });
    }

    console.log(`Converting TMDB ID ${tmdb_id} to IMDB ID...`);
    const imdbId = await tmdbToImdb(tmdb_id, "tv");

    if (!imdbId) {
      return res.status(404).json({ error: "IMDB ID not found for this TMDB ID" });
    }

    const embedUrl = `${BASEURL}/tv/${imdbId}/${season}-${episode}`;
    console.log(`Fetching TV: ${embedUrl}`);

    const embedRes = await fetch(embedUrl, { headers: getHeaders() });
    const embedHtml = await embedRes.text();

    // Extract base domain from iframe
    const iframeMatch = embedHtml.match(/src="([^"]*)"/);
    let baseDOM = "https://cloudnestra.com";

    if (iframeMatch) {
      const iframeSrc = iframeMatch[1];
      const url = new URL(iframeSrc.startsWith("//") ? "https:" + iframeSrc : iframeSrc);
      baseDOM = `${url.protocol}//${url.host}`;
    }

    const streams = await extractRCPData(embedHtml, baseDOM);

    if (streams.length === 0) {
      return res.status(404).json({ error: "No streams found" });
    }

    res.json({ 
      tmdb_id,
      imdb_id: imdbId,
      season: parseInt(season),
      episode: parseInt(episode),
      type: "tv",
      streams: streams.map(s => ({
        url: `/stream?url=${encodeURIComponent(s.url)}&referer=${encodeURIComponent(s.referer)}`,
        originalUrl: s.url,
        referer: s.referer
      }))
    });
  } catch (error) {
    console.error("Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Proxy stream request with proper headers
app.get("/stream", async (req, res) => {
  try {
    const { url, referer } = req.query;

    if (!url) {
      return res.status(400).json({ error: "Stream URL required" });
    }

    const headers = {
      "User-Agent": getRandomUserAgent(),
      "Referer": referer || "https://cloudnestra.com",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Range": req.headers.range || "",
    };

    console.log(`Proxying stream: ${url}`);
    const streamRes = await fetch(url, { headers });

    // Forward response headers
    res.set("Content-Type", streamRes.headers.get("content-type"));
    res.set("Access-Control-Allow-Origin", "*");

    if (streamRes.headers.get("content-length")) {
      res.set("Content-Length", streamRes.headers.get("content-length"));
    }

    streamRes.body.pipe(res);
  } catch (error) {
    console.error("Stream error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({ 
    status: "ok", 
    usage: {
      movie: "GET /movie/:tmdb_id",
      tv: "GET /tv/:tmdb_id/:season/:episode",
      stream: "GET /stream?url=<stream_url>&referer=<referer>"
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});