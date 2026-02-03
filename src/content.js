// content.js
console.log("Twitter High-Res Video Downloader: Content Script Loaded");

// --- Inject the Main World Script ---
const s = document.createElement('script');
s.src = chrome.runtime.getURL('inject.js');
s.onload = function () {
    this.remove();
};
(document.head || document.documentElement).appendChild(s);


// --- Configuration ---
const ICON_SVG = `
<svg viewBox="0 0 24 24" aria-hidden="true">
    <g>
        <path d="M12 16L6 10H10V4H14V10H18L12 16ZM4 18H20V20H4V18Z"></path>
    </g>
</svg>
`;

// inject.js のロード完了フラグ
let injectScriptReady = false;

// 保留中のリクエストを管理
const pendingRequests = new Map();

// --- Filename Helpers ---
const MAX_DISPLAY_NAME_LEN = 24;
const MAX_TEXT_LEN = 15;

function sanitizeFilenamePart(input, maxLen, fallback) {
    if (!input || typeof input !== "string") return fallback;
    // Remove control chars and forbidden filename characters
    let safe = input
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/[\/\\:*?"<>|]/g, "")
        .replace(/\s+/g, "_");

    // Remove non-printable / emoji-like surrogate pairs
    safe = safe.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "");
    // Collapse underscores and trim
    safe = safe.replace(/_+/g, "_").replace(/^_+|_+$/g, "");

    if (!safe) return fallback;
    if (safe.length > maxLen) {
        safe = safe.slice(0, maxLen).replace(/_+$/g, "");
    }
    return safe || fallback;
}

function buildFilename(tweetMeta) {
    const displayName = sanitizeFilenamePart(
        tweetMeta?.displayName || tweetMeta?.username,
        MAX_DISPLAY_NAME_LEN,
        "tweet"
    );
    const text = sanitizeFilenamePart(tweetMeta?.text, MAX_TEXT_LEN, "tweet");

    let tweetId = tweetMeta?.tweetId;
    if (!tweetId && tweetMeta?.tweetUrl) {
        const parts = tweetMeta.tweetUrl.split("/");
        tweetId = parts[parts.length - 1] || null;
    }
    if (!tweetId) {
        tweetId = String(Date.now());
    }

    return `${displayName}_${text}_${tweetId}.mp4`;
}

// --- Helpers ---
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Finds the "Tweet" component root from a child element.
 */
function findTweetRoot(element) {
    return element.closest("article[data-testid='tweet']");
}

function extractTweetMetaFromDom(article) {
    if (!article) return {};
    const meta = {};

    const userNameContainer = article.querySelector('[data-testid="User-Name"]');
    if (userNameContainer) {
        const spans = Array.from(userNameContainer.querySelectorAll('span'));
        const display = spans
            .map((s) => (s.textContent || "").trim())
            .find((t) => t && !t.startsWith("@"));
        if (display) meta.displayName = display;
    }

    const timeLink = article.querySelector('a[href*="/status/"] time');
    if (timeLink && timeLink.parentElement && timeLink.parentElement.tagName === "A") {
        const href = timeLink.parentElement.getAttribute("href");
        try {
            const url = href.startsWith("http")
                ? new URL(href)
                : new URL(href, window.location.origin);
            const parts = url.pathname.split("/").filter(Boolean);
            const statusIndex = parts.indexOf("status");
            if (statusIndex > 0 && parts.length > statusIndex + 1) {
                meta.username = parts[statusIndex - 1];
                meta.tweetId = parts[statusIndex + 1];
                meta.tweetUrl = `${url.origin}/${parts[statusIndex - 1]}/status/${parts[statusIndex + 1]}`;
            }
        } catch (e) {
            // ignore parse errors
        }
    }

    const textEl = article.querySelector('[data-testid="tweetText"]');
    if (textEl && textEl.textContent) {
        meta.text = textEl.textContent.trim();
    }

    if (!meta.username || !meta.tweetId) {
        const linkEl = article.querySelector('a[href*="/status/"]');
        if (linkEl) {
            const href = linkEl.getAttribute("href");
            try {
                const url = href.startsWith("http")
                    ? new URL(href)
                    : new URL(href, window.location.origin);
                const parts = url.pathname.split("/").filter(Boolean);
                const statusIndex = parts.indexOf("status");
                if (statusIndex > 0 && parts.length > statusIndex + 1) {
                    meta.username = meta.username || parts[statusIndex - 1];
                    meta.tweetId = meta.tweetId || parts[statusIndex + 1];
                    meta.tweetUrl = meta.tweetUrl || `${url.origin}/${parts[statusIndex - 1]}/status/${parts[statusIndex + 1]}`;
                }
            } catch (e) {
                // ignore parse errors
            }
        }
    }

    return meta;
}

function mergeTweetMeta(primary, fallback) {
    const result = { ...(fallback || {}) };
    if (primary && typeof primary === "object") {
        for (const key of ["displayName", "username", "text", "tweetId", "tweetUrl"]) {
            if (primary[key]) result[key] = primary[key];
        }
    }
    return result;
}

// --- Main Logic ---

function handleDownloadClick(event) {
    try {
        event.stopPropagation();
        event.preventDefault();

        if (!injectScriptReady) {
            alert("拡張機能の準備中です。少し待ってからもう一度お試しください。");
            return;
        }

        const button = event.currentTarget;
        const tweetArticle = findTweetRoot(button);

        if (!tweetArticle) {
            alert("Error: Could not find tweet.");
            return;
        }

        // Assign a temp ID if not exists, so injected script can find it
        let tweetId = tweetArticle.dataset.twiHaiId;
        if (!tweetId) {
            tweetId = generateUUID();
            tweetArticle.dataset.twiHaiId = tweetId;
        }

        const fallbackMeta = extractTweetMetaFromDom(tweetArticle);

        // リクエストIDを生成して保留リストに追加
        const requestId = generateUUID();
        pendingRequests.set(requestId, { tweetId, button, fallbackMeta });

        console.log("Requesting video for Tweet ID:", tweetId, "Request ID:", requestId);

        // Request URL from Injected Script
        window.postMessage({ type: "TWI_HAI_GET_VIDEO_URL", tweetId: tweetId, requestId: requestId }, "*");
    } catch (err) {
        console.error("Download click handler error:", err);
        alert("Error: " + (err && err.message ? err.message : "Unknown error"));
    }
}

// Listen for responses from Injected Script
window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    // inject.js の準備完了通知
    if (event.data.type === "TWI_HAI_READY") {
        injectScriptReady = true;
        console.log("Inject script ready");
        return;
    }

    if (event.data.type && event.data.type === "TWI_HAI_VIDEO_URL_RESULT") {
        const { url, error, tweetId, requestId, tweetMeta } = event.data;

        // リクエストIDが一致するか確認（存在する場合のみ）
        if (requestId && !pendingRequests.has(requestId)) {
            console.log("Ignoring response for unknown request:", requestId);
            return;
        }

        // 処理済みとしてリクエストを削除
        const pending = requestId ? pendingRequests.get(requestId) : null;
        if (requestId) pendingRequests.delete(requestId);

        if (url) {
            console.log("Received URL:", url);
            const meta = mergeTweetMeta(tweetMeta, pending?.fallbackMeta);
            if (meta.username && meta.tweetId && !meta.tweetUrl) {
                meta.tweetUrl = `https://x.com/${meta.username}/status/${meta.tweetId}`;
            }
            const filename = buildFilename(meta);
            // Send to background script for download
            chrome.runtime.sendMessage({
                action: "download_video",
                url: url,
                filename: filename,
                tweetMeta: meta
            }, (response) => {
                if (chrome.runtime.lastError) {
                    alert("Download failed: " + chrome.runtime.lastError.message);
                } else if (!response || !response.success) {
                    alert("Download failed: " + (response ? response.error : "Unknown error"));
                }
            });
        } else if (error) {
            console.error("Extraction Error:", error);
            alert("Could not get video: " + error);
        }
    }
});


/**
 * ツイートに動画が含まれているかチェック
 */
function hasVideo(article) {
    // video要素をチェック
    if (article.querySelector('video')) return true;
    // Twitter固有のvideoPlayerコンポーネントをチェック
    if (article.querySelector('[data-testid="videoPlayer"]')) return true;
    if (article.querySelector('[data-testid="videoComponent"]')) return true;
    // GIFもチェック（animated_gif）
    if (article.querySelector('[data-testid="tweetPhoto"] video')) return true;
    return false;
}

function processTweet(article) {
    // 既にボタンが追加済みならスキップ
    if (article.dataset.twiHaiHasButton === "true") return;

    // 動画がないツイートにはボタンを追加しない
    // （動画は遅延読み込みされるので、後で再チェックされる）
    if (!hasVideo(article)) return;

    // Find the Action Bar (より具体的なセレクタを使用)
    // ツイートのアクションバーは通常、返信・RT・いいね・共有ボタンを含むグループ
    const actionBar = article.querySelector('[role="group"][id]') ||
                      article.querySelector('div[role="group"]:last-of-type') ||
                      article.querySelector('[role="group"]');
    if (!actionBar) return;

    // 既にボタンがある場合はスキップ
    if (actionBar.querySelector('.twi-hai-dl-btn')) {
        article.dataset.twiHaiHasButton = "true";
        return;
    }

    // Create Button
    const btn = document.createElement("div");
    btn.className = "twi-hai-dl-btn";
    btn.innerHTML = ICON_SVG;
    btn.title = "Download Video";
    btn.onclick = handleDownloadClick;

    // Append to action bar.
    actionBar.appendChild(btn);
    article.dataset.twiHaiHasButton = "true";
}

// Initial Scan
let scanTimer = null;
function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
        scanTimer = null;
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        articles.forEach(processTweet);
    }, 200);
}

function processNode(node) {
    if (!(node instanceof Element)) return;

    if (node.matches && node.matches("article[data-testid='tweet']")) {
        processTweet(node);
        return;
    }

    const articles = node.querySelectorAll
        ? node.querySelectorAll("article[data-testid='tweet']")
        : [];
    articles.forEach(processTweet);
}

// Observer
const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
        if (m.addedNodes.length > 0) {
            m.addedNodes.forEach(processNode);
        }
    }
    scheduleScan();
});

observer.observe(document.body, { childList: true, subtree: true });

// Run once on load
scheduleScan();
