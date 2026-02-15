const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const GDELT_API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GOOGLE_FACT_CHECK_API = 'https://factchecktools.googleapis.com/v1alpha1/claims:search';
const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const PUBMED_ESEARCH_API = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_ESUMMARY_API = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const APP_USER_AGENT = 'VerityLens/1.0 (local fact-check assistant)';

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

const ENV = loadEnv(path.join(__dirname, '.env'));
const GOOGLE_FACT_CHECK_API_KEY = ENV.GOOGLE_FACT_CHECK_API_KEY || '';

function loadEnv(filePath) {
    const env = {};

    if (!fs.existsSync(filePath)) {
        return env;
    }

    const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;

        const key = match[1];
        let value = match[2] || '';
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        env[key] = value;
    }

    return env;
}

function isGoogleFactCheckConfigured() {
    return !!(
        GOOGLE_FACT_CHECK_API_KEY &&
        GOOGLE_FACT_CHECK_API_KEY !== 'YOUR_GOOGLE_FACT_CHECK_API_KEY_HERE'
    );
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchUrl(url, method = 'GET', body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method,
            headers: {
                'User-Agent': APP_USER_AGENT,
                ...headers,
            },
        };

        const req = https.request(options, res => {
            let payload = '';
            res.on('data', chunk => payload += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, body: payload }));
        });

        req.on('error', reject);
        req.setTimeout(20000, () => req.destroy(new Error('Request timed out')));

        if (body) {
            req.write(body);
        }

        req.end();
    });
}

async function fetchJson(url, label) {
    const result = await fetchUrl(url);

    if (result.statusCode < 200 || result.statusCode >= 300) {
        throw new Error(`${label} returned HTTP ${result.statusCode}`);
    }

    try {
        return JSON.parse(result.body);
    } catch {
        throw new Error(`${label} returned invalid JSON`);
    }
}

function stripHtml(input) {
    return (input || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function truncateForLog(value, max = 120) {
    if (!value) return '';
    if (value.length <= max) return value;
    return value.slice(0, max).trim() + '...';
}

function normalizeVerdict(text) {
    const t = (text || '').toLowerCase();
    if (!t) return 'unknown';

    if (/(false|pants on fire|incorrect|fake|hoax|scam|baseless|fabricated|no evidence|debunked|not true|mostly false)/.test(t)) {
        return 'contradicted';
    }

    if (/(true|correct|accurate|supported|mostly true|legit|legitimate)/.test(t)) {
        return 'supported';
    }

    if (/(misleading|partly|partially|half true|mixed|out of context|context missing|needs context|disputed|unproven)/.test(t)) {
        return 'contested';
    }

    return 'unknown';
}

function classifyClaimStatus(factChecks, corroboration) {
    const tally = {
        supported: 0,
        contradicted: 0,
        contested: 0,
        unknown: 0,
    };

    for (const item of factChecks) {
        const verdict = item.normalizedVerdict || 'unknown';
        if (tally[verdict] == null) {
            tally.unknown += 1;
        } else {
            tally[verdict] += 1;
        }
    }

    if (tally.contradicted > 0 && tally.supported === 0 && tally.contested === 0) {
        return {
            code: 'contradicted',
            label: 'Contradicted',
            reason: 'Independent fact-check publishers rate this claim as false or unsupported.',
            confidence: 'high',
        };
    }

    if (tally.supported > 0 && tally.contradicted === 0 && tally.contested === 0) {
        return {
            code: 'supported',
            label: 'Supported',
            reason: 'Independent fact-check publishers rate this claim as true or mostly true.',
            confidence: 'high',
        };
    }

    if ((tally.supported + tally.contradicted + tally.contested) > 0) {
        return {
            code: 'contested',
            label: 'Contested',
            reason: 'Fact-check verdicts are mixed, nuanced, or context-dependent across publishers.',
            confidence: 'medium',
        };
    }

    const corroborationSignals = ['wikipedia', 'wikidata', 'pubmed']
        .reduce((acc, key) => acc + ((corroboration[key] || []).length > 0 ? 1 : 0), 0);

    if (corroborationSignals >= 2) {
        return {
            code: 'unverified',
            label: 'Unverified',
            reason: 'No direct fact-check match found; trusted reference sources are provided for manual review.',
            confidence: 'low',
        };
    }

    return {
        code: 'unverified',
        label: 'Unverified',
        reason: 'No direct fact-check match or reliable corroboration was found for this claim.',
        confidence: 'low',
    };
}

async function searchGoogleFactChecks(claim) {
    if (!isGoogleFactCheckConfigured()) {
        return { configured: false, matches: [] };
    }

    const params = new URLSearchParams({
        query: claim,
        languageCode: 'en',
        pageSize: '10',
        key: GOOGLE_FACT_CHECK_API_KEY,
    });

    const url = `${GOOGLE_FACT_CHECK_API}?${params.toString()}`;
    const json = await fetchJson(url, 'Google Fact Check Tools API');
    const claims = Array.isArray(json.claims) ? json.claims : [];

    const matches = [];
    for (const claimItem of claims) {
        const claimText = claimItem.text || claim;
        const claimant = claimItem.claimant || '';
        const claimReviews = Array.isArray(claimItem.claimReview) ? claimItem.claimReview : [];

        for (const review of claimReviews) {
            const publisherName = review.publisher?.name || review.publisher?.site || 'Unknown Publisher';
            const textualRating = review.textualRating || '';
            const reviewTitle = review.title || 'Fact-check review';
            const normalizedVerdict = normalizeVerdict(`${textualRating} ${reviewTitle}`);

            matches.push({
                claimText,
                claimant,
                publisher: publisherName,
                reviewTitle,
                textualRating,
                reviewUrl: review.url || '',
                reviewDate: review.reviewDate || '',
                languageCode: review.languageCode || '',
                normalizedVerdict,
                sourceType: 'Google Fact Check API',
            });
        }
    }

    const deduped = [];
    const seen = new Set();

    for (const item of matches) {
        const key = item.reviewUrl || `${item.publisher}|${item.reviewTitle}|${item.reviewDate}`;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
    }

    return { configured: true, matches: deduped.slice(0, 12) };
}

async function searchWikipedia(claim) {
    const params = new URLSearchParams({
        action: 'query',
        list: 'search',
        srsearch: claim,
        utf8: '1',
        format: 'json',
        srlimit: '5',
    });

    const url = `${WIKIPEDIA_API}?${params.toString()}`;
    const json = await fetchJson(url, 'Wikipedia API');
    const results = Array.isArray(json.query?.search) ? json.query.search : [];

    return results.map(item => ({
        title: item.title || 'Wikipedia page',
        snippet: stripHtml(item.snippet || ''),
        url: `https://en.wikipedia.org/?curid=${item.pageid}`,
        source: 'Wikipedia',
    }));
}

async function searchWikidata(claim) {
    const params = new URLSearchParams({
        action: 'wbsearchentities',
        search: claim,
        language: 'en',
        format: 'json',
        limit: '5',
    });

    const url = `${WIKIDATA_API}?${params.toString()}`;
    const json = await fetchJson(url, 'Wikidata API');
    const results = Array.isArray(json.search) ? json.search : [];

    return results.map(item => ({
        title: item.label || item.id || 'Wikidata entity',
        snippet: item.description || '',
        url: item.concepturi || `https://www.wikidata.org/wiki/${item.id}`,
        source: 'Wikidata',
    }));
}

async function searchPubMed(claim) {
    const esearchParams = new URLSearchParams({
        db: 'pubmed',
        term: claim,
        retmode: 'json',
        retmax: '5',
        sort: 'relevance',
    });

    const esearchUrl = `${PUBMED_ESEARCH_API}?${esearchParams.toString()}`;
    const esearchJson = await fetchJson(esearchUrl, 'PubMed ESearch API');
    const ids = Array.isArray(esearchJson.esearchresult?.idlist) ? esearchJson.esearchresult.idlist : [];

    if (ids.length === 0) {
        return [];
    }

    const esummaryParams = new URLSearchParams({
        db: 'pubmed',
        id: ids.join(','),
        retmode: 'json',
    });

    const esummaryUrl = `${PUBMED_ESUMMARY_API}?${esummaryParams.toString()}`;
    const esummaryJson = await fetchJson(esummaryUrl, 'PubMed ESummary API');
    const result = esummaryJson.result || {};
    const uids = Array.isArray(result.uids) ? result.uids : ids;

    const papers = [];
    for (const uid of uids) {
        const item = result[uid] || {};
        if (!item.title) continue;

        const journal = item.fulljournalname || item.source || 'PubMed';
        const pubDate = item.pubdate || '';

        papers.push({
            title: item.title,
            snippet: `${journal}${pubDate ? ` (${pubDate})` : ''}`,
            url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
            source: 'PubMed',
        });
    }

    return papers;
}

async function proxyGDELT(queryString, res) {
    const gdeltUrl = `${GDELT_API}?${queryString}`;
    console.log(`[gdelt] -> ${gdeltUrl.substring(0, 120)}...`);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const result = await fetchUrl(gdeltUrl);

            if (result.statusCode === 429) {
                console.log(`[gdelt] 429 rate limited, retry ${attempt}/${MAX_RETRIES}`);
                if (attempt < MAX_RETRIES) {
                    await sleep(RETRY_DELAY_MS * attempt);
                    continue;
                }
                respond(res, 200, { articles: [] });
                return;
            }

            let json;
            try {
                json = JSON.parse(result.body);
            } catch {
                console.log('[gdelt] non-JSON, returning empty');
                respond(res, 200, { articles: [] });
                return;
            }

            respond(res, 200, json);
            console.log(`[gdelt] <- ${result.body.length} bytes`);
            return;
        } catch (err) {
            console.error(`[gdelt] attempt ${attempt} error:`, err.message);
            if (attempt === MAX_RETRIES) {
                respond(res, 502, { error: err.message });
                return;
            }
            await sleep(RETRY_DELAY_MS);
        }
    }
}

async function proxyVerification(reqBody, res) {
    const claim = String(reqBody.claim || '').trim();

    if (!claim) {
        respond(res, 400, { error: 'Claim is required.' });
        return;
    }

    console.log(`[verify] -> ${truncateForLog(claim, 100)}`);

    const [factChecksResult, wikipediaResult, wikidataResult, pubmedResult] = await Promise.allSettled([
        searchGoogleFactChecks(claim),
        searchWikipedia(claim),
        searchWikidata(claim),
        searchPubMed(claim),
    ]);

    const factChecksPayload = factChecksResult.status === 'fulfilled'
        ? factChecksResult.value
        : { configured: isGoogleFactCheckConfigured(), matches: [] };

    const factChecks = factChecksPayload.matches || [];

    const corroboration = {
        wikipedia: wikipediaResult.status === 'fulfilled' ? wikipediaResult.value : [],
        wikidata: wikidataResult.status === 'fulfilled' ? wikidataResult.value : [],
        pubmed: pubmedResult.status === 'fulfilled' ? pubmedResult.value : [],
    };

    const status = classifyClaimStatus(factChecks, corroboration);

    const errors = {};
    if (factChecksResult.status === 'rejected') errors.factChecks = factChecksResult.reason?.message || 'Google Fact Check failed';
    if (wikipediaResult.status === 'rejected') errors.wikipedia = wikipediaResult.reason?.message || 'Wikipedia lookup failed';
    if (wikidataResult.status === 'rejected') errors.wikidata = wikidataResult.reason?.message || 'Wikidata lookup failed';
    if (pubmedResult.status === 'rejected') errors.pubmed = pubmedResult.reason?.message || 'PubMed lookup failed';

    respond(res, 200, {
        claim,
        status,
        factChecks,
        corroboration,
        apiStatus: {
            googleFactCheckConfigured: factChecksPayload.configured,
        },
        errors,
    });

    console.log(
        `[verify] <- ${status.code}; factChecks=${factChecks.length}, wiki=${corroboration.wikipedia.length}, wikidata=${corroboration.wikidata.length}, pubmed=${corroboration.pubmed.length}`
    );
}

function respond(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(JSON.stringify(data));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                resolve({});
            }
        });
        req.on('error', reject);
    });
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
    }

    if (req.url.startsWith('/api/gdelt?')) {
        proxyGDELT(req.url.slice('/api/gdelt?'.length), res);
        return;
    }

    if (req.url === '/api/verify' && req.method === 'POST') {
        const body = await readBody(req);
        proxyVerification(body, res);
        return;
    }

    if (req.url === '/api/factcheck/status' && req.method === 'GET') {
        respond(res, 200, {
            configured: isGoogleFactCheckConfigured(),
        });
        return;
    }

    let filePath = req.url.split('?')[0];
    filePath = filePath === '/' ? '/index.html' : filePath;
    filePath = path.join(__dirname, filePath);

    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(err.code === 'ENOENT' ? 404 : 500);
            res.end(err.code === 'ENOENT' ? 'Not Found' : 'Server Error');
            return;
        }

        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

server.listen(PORT, () => {
    const factCheckStatus = isGoogleFactCheckConfigured() ? 'configured' : 'not configured (set GOOGLE_FACT_CHECK_API_KEY in .env)';

    console.log(`\n  VerityLens server running at:\n`);
    console.log(`  -> http://localhost:${PORT}\n`);
    console.log('  APIs:');
    console.log('  - GDELT proxy:       /api/gdelt?query=...');
    console.log('  - Verify pipeline:   /api/verify (POST)');
    console.log('  - Fact-check status: /api/factcheck/status');
    console.log(`  - Google Fact Check: ${factCheckStatus}\n`);
});
