/* ============================================
   VerityLens - Application Logic
   ============================================ */

(() => {
    'use strict';

    // ---- Configuration ---- //
    const GDELT_API = '/api/gdelt';
    const VERIFY_API = '/api/verify';
    const FALLBACK_BACKEND_ORIGIN = 'http://localhost:3000';
    const MAX_RECORDS = 75;

    // Trusted fact-check domains
    const FACTCHECK_DOMAINS = [
        'snopes.com', 'politifact.com', 'factcheck.org',
        'reuters.com', 'apnews.com', 'bbc.com',
        'fullfact.org', 'checkyourfact.com', 'truthorfiction.com',
        'leadstories.com', 'usatoday.com', 'washingtonpost.com'
    ];

    // Credible news domains
    const CREDIBLE_DOMAINS = [
        'reuters.com', 'apnews.com', 'bbc.com', 'npr.org',
        'theguardian.com', 'nytimes.com', 'washingtonpost.com',
        'pbs.org', 'aljazeera.com', 'economist.com',
        'nature.com', 'sciencemag.org', 'who.int', 'cdc.gov',
        'usatoday.com', 'cbsnews.com', 'nbcnews.com', 'abcnews.go.com'
    ];

    // ---- DOM Elements ---- //
    const claimInput = document.getElementById('claim-input');
    const charCount = document.getElementById('char-count');
    const searchBtn = document.getElementById('search-btn');
    const timespanSelect = document.getElementById('timespan-select');
    const modeSelect = document.getElementById('mode-select');
    const toneSelect = document.getElementById('tone-select');

    const verificationPanel = document.getElementById('verification-panel');
    const verificationLoading = document.getElementById('verification-loading');
    const verificationStatus = document.getElementById('verification-status');
    const verificationReason = document.getElementById('verification-reason');
    const verificationMeta = document.getElementById('verification-meta');
    const factcheckList = document.getElementById('factcheck-list');
    const corroborationList = document.getElementById('corroboration-list');

    const resultsGrid = document.getElementById('results-grid');
    const resultsStats = document.getElementById('results-stats');
    const resultsCountEl = document.getElementById('results-count');
    const resultsQueryEl = document.getElementById('results-query');
    const skeletonLoader = document.getElementById('skeleton-loader');
    const emptyState = document.getElementById('empty-state');
    const errorState = document.getElementById('error-state');
    const errorMessage = document.getElementById('error-message');

    // ---- Character Counter ---- //
    claimInput.addEventListener('input', () => {
        charCount.textContent = claimInput.value.length;
    });

    // ---- Button Ripple Effect ---- //
    searchBtn.addEventListener('click', function (e) {
        const ripple = this.querySelector('.btn-ripple');
        const rect = this.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height);
        ripple.style.width = ripple.style.height = size + 'px';
        ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
        ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
        ripple.style.animation = 'none';
        ripple.offsetHeight;
        ripple.style.animation = 'ripple 0.6s linear';

        handleSearch();
    });

    // Allow Ctrl+Enter / Cmd+Enter to trigger search
    claimInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleSearch();
        }
    });

    // ---- Core Search Logic ---- //
    async function handleSearch() {
        const claim = claimInput.value.trim();
        if (!claim) {
            claimInput.focus();
            return;
        }

        showLoading();
        searchBtn.disabled = true;

        try {
            const gdeltPromise = searchGDELT(claim);
            const verifyPromise = fetchVerification(claim);

            const [gdeltResult, verifyResult] = await Promise.allSettled([gdeltPromise, verifyPromise]);

            if (gdeltResult.status === 'fulfilled') {
                const { data, usedFallback } = gdeltResult.value;
                if (!isEmpty(data)) {
                    renderResults(data.articles, claim, usedFallback);
                } else {
                    showEmpty();
                }
            } else {
                showError(gdeltResult.reason?.message || 'GDELT search failed.');
            }

            if (verifyResult.status === 'fulfilled' && verifyResult.value) {
                renderVerification(verifyResult.value);
            } else {
                renderVerificationUnavailable();
            }
        } catch (err) {
            console.error('Search error:', err);
            showError(err.message || 'Unable to search right now.');
            renderVerificationUnavailable();
        } finally {
            verificationLoading.style.display = 'none';
            searchBtn.disabled = false;
        }
    }

    function isEmpty(data) {
        return !data || !data.articles || data.articles.length === 0;
    }

    // GDELT search with fallback chain
    async function searchGDELT(claim) {
        let data = null;
        let usedFallback = false;

        const query = buildQuery(claim);
        const url = buildApiUrl(query);
        data = await fetchGDELT(url);

        const mode = modeSelect.value;
        if (isEmpty(data) && mode !== 'all') {
            const fallbackQuery = buildQuery(claim, 'all');
            data = await fetchGDELT(buildApiUrl(fallbackQuery));
            usedFallback = true;
        }

        if (isEmpty(data)) {
            const looseKeywords = extractLooseKeywords(claim);
            data = await fetchGDELT(buildApiUrl(looseKeywords));
            usedFallback = true;
        }

        return { data, usedFallback };
    }

    async function fetchVerification(claim) {
        try {
            const response = await fetchApiWithFallback(VERIFY_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ claim }),
            });

            if (!response.ok) {
                return null;
            }

            return await response.json();
        } catch {
            return null;
        }
    }

    // ---- Query Construction ---- //
    function buildQuery(claim, modeOverride) {
        const keywords = extractKeywords(claim);
        const mode = modeOverride || modeSelect.value;

        let query = keywords;

        if (mode === 'factcheck') {
            const domainFilter = FACTCHECK_DOMAINS.map(d => `domainis:${d}`).join(' OR ');
            query += ` (${domainFilter})`;
        } else if (mode === 'credible') {
            const domainFilter = CREDIBLE_DOMAINS.map(d => `domainis:${d}`).join(' OR ');
            query += ` (${domainFilter})`;
        }

        const tone = toneSelect.value;
        if (tone === 'positive') {
            query += ' tone>3';
        } else if (tone === 'negative') {
            query += ' tone<-3';
        }

        return query;
    }

    function extractKeywords(claim) {
        const stopWords = new Set([
            'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
            'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
            'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
            'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
            'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
            'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
            'once', 'here', 'there', 'when', 'where', 'why', 'how', 'each',
            'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
            'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
            'because', 'but', 'and', 'or', 'if', 'while', 'that', 'this', 'these',
            'those', 'it', 'its', 'me', 'my', 'we', 'our', 'you', 'your',
            'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their', 'what',
            'which', 'who', 'whom', 'about', 'up', 'down', 'also', 'really',
            'actually', 'basically', 'literally', 'totally', 'completely',
            'says', 'said', 'according', 'claims', 'claim', 'reported', 'reports',
            'now', 'know', 'think', 'like', 'get', 'got', 'make', 'made',
            'come', 'came', 'take', 'took', 'see', 'saw', 'tell', 'told',
            'say', 'going', 'want', 'look', 'looking', 'way', 'thing', 'things',
            'lot', 'much', 'many', 'well', 'even', 'back', 'still', 'already',
            'yet', 'though', 'since', 'keep', 'let', 'begin', 'seem',
            'help', 'show', 'hear', 'play', 'run', 'move', 'live', 'believe',
            'bring', 'happen', 'must', 'provide', 'become', 'leave',
            'work', 'call', 'try', 'ask', 'use', 'find', 'give', 'first',
            'new', 'old', 'long', 'great', 'little', 'right', 'big',
            'high', 'small', 'large', 'next', 'early', 'young', 'important',
            'last', 'bad', 'good', 'best', 'sure', 'able', 'real'
        ]);

        const words = claim.trim().split(/\s+/);
        if (words.length <= 7) {
            const cleaned = claim.replace(/["']/g, '').trim();
            return `"${cleaned}"`;
        }

        let cleaned = claim
            .replace(/["']/g, '')
            .replace(/[^\w\s'-]/g, ' ')
            .split(/\s+/)
            .filter(word => {
                const lower = word.toLowerCase();
                return word.length > 2 && !stopWords.has(lower);
            });

        if (cleaned.length > 8) {
            cleaned = cleaned.slice(0, 8);
        }

        if (cleaned.length < 2) {
            return words.slice(0, 5).join(' ');
        }

        return cleaned.join(' ');
    }

    function extractLooseKeywords(claim) {
        const stopWords = new Set([
            'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
            'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
            'should', 'may', 'might', 'shall', 'can', 'need', 'to', 'of', 'in',
            'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
            'during', 'before', 'after', 'between', 'out', 'off', 'over', 'under',
            'that', 'this', 'these', 'those', 'it', 'its', 'we', 'our', 'you',
            'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their',
            'what', 'which', 'who', 'whom', 'and', 'or', 'but', 'if', 'not', 'no',
            'so', 'than', 'too', 'very', 'just', 'about', 'also', 'now', 'know',
            'said', 'says', 'say', 'been', 'being', 'same', 'own', 'such',
            'because', 'while', 'here', 'there', 'where', 'when', 'how', 'why',
            'all', 'each', 'every', 'both', 'some', 'most', 'other', 'only'
        ]);

        return claim
            .replace(/["']/g, '')
            .replace(/[^\w\s'-]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()))
            .slice(0, 6)
            .join(' ') || claim.split(/\s+/).slice(0, 4).join(' ');
    }

    function buildApiUrl(query) {
        const timespan = timespanSelect.value;
        const q = encodeURIComponent(query);
        const ts = encodeURIComponent(timespan);
        return `${GDELT_API}?query=${q}&mode=ArtList&format=json&maxrecords=${MAX_RECORDS}&timespan=${ts}&sort=ToneDesc`;
    }

    // ---- API Fetch (via local proxy) ---- //
    async function fetchGDELT(url) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        try {
            const response = await fetchApiWithFallback(url, { signal: controller.signal });
            clearTimeout(timeout);

            if (!response.ok) {
                throw new Error(`Server error (${response.status}). Please try again.`);
            }

            const data = await response.json();
            return data;
        } catch (err) {
            clearTimeout(timeout);
            if (err.name === 'AbortError') {
                throw new Error('Request timed out. GDELT may be busy - try again shortly.');
            }
            throw err;
        }
    }

    async function fetchApiWithFallback(path, options = {}) {
        let primaryResponse = null;
        let primaryError = null;

        try {
            primaryResponse = await fetch(path, options);
        } catch (err) {
            primaryError = err;
        }

        const isRelativePath = typeof path === 'string' && path.startsWith('/');
        const shouldFallbackFromError = !!primaryError && isRelativePath && window.location.origin !== FALLBACK_BACKEND_ORIGIN;
        if (shouldFallbackFromError) {
            const fallbackUrl = `${FALLBACK_BACKEND_ORIGIN}${path}`;
            return fetch(fallbackUrl, options);
        }

        if (primaryError) {
            throw primaryError;
        }

        const canFallback = primaryResponse.status === 404 &&
            window.location.origin !== FALLBACK_BACKEND_ORIGIN &&
            isRelativePath;

        if (!canFallback) {
            return primaryResponse;
        }

        const fallbackUrl = `${FALLBACK_BACKEND_ORIGIN}${path}`;
        return fetch(fallbackUrl, options);
    }

    // ---- Rendering ---- //
    function renderResults(articles, claim, usedFallback) {
        resultsGrid.innerHTML = '';

        resultsStats.style.display = 'flex';
        resultsCountEl.textContent = `${articles.length} article${articles.length !== 1 ? 's' : ''} found`;
        const fallbackNote = usedFallback ? ' (broadened to all sources)' : '';
        resultsQueryEl.textContent = `Counter-evidence for: "${truncate(claim, 60)}"${fallbackNote}`;

        articles.forEach((article, index) => {
            const card = createArticleCard(article, index);
            resultsGrid.appendChild(card);
        });
    }

    function renderVerification(data) {
        verificationLoading.style.display = 'none';
        verificationPanel.style.display = 'block';

        const status = data.status || {};
        const code = status.code || 'unverified';
        verificationStatus.textContent = status.label || 'Unverified';
        verificationStatus.className = `verification-status status-${code}`;

        verificationReason.textContent = status.reason || 'No verification summary available.';

        const factChecksCount = Array.isArray(data.factChecks) ? data.factChecks.length : 0;
        const wikiCount = Array.isArray(data.corroboration?.wikipedia) ? data.corroboration.wikipedia.length : 0;
        const wikidataCount = Array.isArray(data.corroboration?.wikidata) ? data.corroboration.wikidata.length : 0;
        const pubmedCount = Array.isArray(data.corroboration?.pubmed) ? data.corroboration.pubmed.length : 0;

        const metaParts = [
            `Fact-check matches: ${factChecksCount}`,
            `Wikipedia: ${wikiCount}`,
            `Wikidata: ${wikidataCount}`,
            `PubMed: ${pubmedCount}`,
        ];

        if (!data.apiStatus?.googleFactCheckConfigured) {
            metaParts.unshift('Google Fact Check API key not configured');
        }

        verificationMeta.textContent = metaParts.join(' | ');

        renderFactChecks(Array.isArray(data.factChecks) ? data.factChecks : []);
        renderCorroboration(data.corroboration || {});
    }

    function renderVerificationUnavailable() {
        verificationLoading.style.display = 'none';
        verificationPanel.style.display = 'block';
        verificationStatus.textContent = 'Unavailable';
        verificationStatus.className = 'verification-status status-unverified';
        verificationReason.textContent = 'Verification APIs are temporarily unavailable. Showing GDELT results only.';
        verificationMeta.textContent = '';
        factcheckList.innerHTML = '<div class="source-empty">No fact-check data available.</div>';
        corroborationList.innerHTML = '<div class="source-empty">No corroboration data available.</div>';
    }

    function renderFactChecks(items) {
        if (!items.length) {
            factcheckList.innerHTML = '<div class="source-empty">No direct ClaimReview match found for this claim.</div>';
            return;
        }

        factcheckList.innerHTML = items.map(item => {
            const verdictClass = `verdict-${item.normalizedVerdict || 'unknown'}`;
            const verdictLabel = getVerdictLabel(item.normalizedVerdict, item.textualRating);
            const publisher = escapeHtml(item.publisher || 'Unknown publisher');
            const reviewTitle = escapeHtml(item.reviewTitle || 'Fact-check review');
            const claimText = escapeHtml(truncate(item.claimText || '', 160));
            const ratingText = item.textualRating ? escapeHtml(truncate(item.textualRating, 180)) : '';
            const showRatingDetail = ratingText && verdictLabel.toLowerCase() !== (item.textualRating || '').toLowerCase();
            const reviewDate = formatDate(item.reviewDate);

            return `
                <article class="source-card">
                    <div class="source-card-top">
                        <span class="source-label">${publisher}</span>
                        <span class="verdict-pill ${verdictClass}" title="${escapeHtml(item.textualRating || verdictLabel)}">${escapeHtml(verdictLabel)}</span>
                    </div>
                    <h4 class="source-title">${reviewTitle}</h4>
                    ${claimText ? `<p class="source-snippet">Claim: ${claimText}</p>` : ''}
                    ${showRatingDetail ? `<p class="source-rating-detail">Rating detail: ${ratingText}</p>` : ''}
                    <div class="source-meta-row">
                        ${reviewDate ? `<span class="source-meta">${reviewDate}</span>` : ''}
                        ${item.reviewUrl ? `<a class="source-link" href="${escapeHtml(item.reviewUrl)}" target="_blank" rel="noopener noreferrer">Open Fact Check</a>` : ''}
                    </div>
                </article>
            `;
        }).join('');
    }

    function renderCorroboration(corroboration) {
        const groups = [
            {
                name: 'Wikipedia',
                items: Array.isArray(corroboration.wikipedia) ? corroboration.wikipedia : [],
            },
            {
                name: 'Wikidata',
                items: Array.isArray(corroboration.wikidata) ? corroboration.wikidata : [],
            },
            {
                name: 'PubMed',
                items: Array.isArray(corroboration.pubmed) ? corroboration.pubmed : [],
            },
        ];

        const hasAny = groups.some(group => group.items.length > 0);
        if (!hasAny) {
            corroborationList.innerHTML = '<div class="source-empty">No corroboration sources were found.</div>';
            return;
        }

        corroborationList.innerHTML = groups.map(group => {
            if (!group.items.length) return '';

            const rows = group.items.map(item => {
                const title = escapeHtml(item.title || 'Source');
                const snippet = escapeHtml(item.snippet || '');
                const url = escapeHtml(item.url || '#');

                return `
                    <article class="source-card">
                        <div class="source-card-top">
                            <span class="source-label">${group.name}</span>
                        </div>
                        <h4 class="source-title">${title}</h4>
                        ${snippet ? `<p class="source-snippet">${snippet}</p>` : ''}
                        <div class="source-meta-row">
                            <a class="source-link" href="${url}" target="_blank" rel="noopener noreferrer">Open Source</a>
                        </div>
                    </article>
                `;
            }).join('');

            return `
                <section class="source-group">
                    <h4 class="source-group-title">${group.name}</h4>
                    <div class="source-group-list">${rows}</div>
                </section>
            `;
        }).join('');
    }

    function createArticleCard(article, index) {
        const card = document.createElement('div');
        card.className = 'article-card';
        card.style.animationDelay = `${index * 0.05}s`;

        const domain = extractDomain(article.url || '');
        const toneValue = article.tone != null ? parseFloat(article.tone) : null;
        const toneLabel = getToneLabel(toneValue);
        const toneClass = getToneClass(toneValue);
        const date = formatDate(article.seendate);
        const title = article.title || 'Untitled Article';
        const url = article.url || '#';
        const language = article.language || '';
        const excerpt = article.socialimage ? '' : (article.excerpt || '');

        const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;

        card.innerHTML = `
            <div class="card-header">
                <div class="card-source">
                    <img class="source-favicon" src="${faviconUrl}" alt="" loading="lazy" onerror="this.style.display='none'">
                    <span class="source-domain">${escapeHtml(domain)}</span>
                </div>
                ${toneValue !== null ? `
                    <span class="tone-badge ${toneClass}">
                        ${toneLabel} ${toneValue > 0 ? '+' : ''}${toneValue.toFixed(1)}
                    </span>
                ` : ''}
            </div>
            <h3 class="card-title">
                <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>
            </h3>
            <div class="card-meta">
                ${date ? `<span class="card-date">${date}</span>` : ''}
                ${language ? `<span class="card-language">${escapeHtml(language)}</span>` : ''}
            </div>
            ${excerpt ? `<p class="card-excerpt">${escapeHtml(truncate(excerpt, 180))}</p>` : ''}
            <div class="card-actions">
                <a class="read-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
                    Read Article
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                </a>
            </div>
        `;

        return card;
    }

    // ---- UI State Management ---- //
    function showLoading() {
        hideAllStates();
        skeletonLoader.style.display = 'grid';
        verificationLoading.style.display = 'block';
    }

    function showEmpty() {
        hideAllStates();
        emptyState.style.display = 'block';
    }

    function showError(msg) {
        hideAllStates();
        errorMessage.textContent = msg;
        errorState.style.display = 'block';
    }

    function hideAllStates() {
        skeletonLoader.style.display = 'none';
        emptyState.style.display = 'none';
        errorState.style.display = 'none';

        verificationLoading.style.display = 'none';
        verificationPanel.style.display = 'none';

        resultsStats.style.display = 'none';
        resultsGrid.innerHTML = '';

        verificationStatus.textContent = '';
        verificationReason.textContent = '';
        verificationMeta.textContent = '';
        factcheckList.innerHTML = '';
        corroborationList.innerHTML = '';
    }

    // ---- Helpers ---- //
    function extractDomain(url) {
        try {
            const u = new URL(url);
            return u.hostname.replace(/^www\./, '');
        } catch {
            return url.split('/')[2] || 'unknown';
        }
    }

    function getToneLabel(tone) {
        if (tone === null) return '';
        if (tone > 2) return 'Positive';
        if (tone < -2) return 'Negative';
        return 'Neutral';
    }

    function getToneClass(tone) {
        if (tone === null) return 'tone-neutral';
        if (tone > 2) return 'tone-positive';
        if (tone < -2) return 'tone-negative';
        return 'tone-neutral';
    }

    function formatDate(dateStr) {
        if (!dateStr) return '';
        try {
            const normalized = /^\d{8}T\d{6}Z$/.test(dateStr)
                ? `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`
                : dateStr;
            const d = new Date(normalized);
            if (isNaN(d.getTime())) return dateStr;

            return d.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
            });
        } catch {
            return dateStr;
        }
    }

    function truncate(str, len) {
        if (!str) return '';
        if (str.length <= len) return str;
        return str.substring(0, len).trim() + '...';
    }

    function getVerdictLabel(normalizedVerdict, textualRating) {
        const rating = (textualRating || '').trim();
        if (rating && rating.length <= 22) {
            return rating;
        }

        switch (normalizedVerdict) {
            case 'contradicted':
                return 'Contradicted';
            case 'supported':
                return 'Supported';
            case 'contested':
                return 'Contested';
            default:
                return rating ? 'Rating Available' : 'Unrated';
        }
    }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
})();
