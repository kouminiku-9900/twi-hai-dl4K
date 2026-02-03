// inject.js v1.0.2
// This script runs in the MAIN world, so it can access React internals

console.log("Twitter High-Res Video Downloader: Injected Script Loaded (v1.0.2)");

(function () {
    // 準備完了を通知
    window.postMessage({ type: "TWI_HAI_READY" }, "*");

    const DEBUG = true;
    function log(...args) {
        if (DEBUG) console.log("[TWI-HAI]", ...args);
    }

    /**
     * DOM要素からReact Fiber/Propsを取得
     * Twitter/Xは __reactFiber$xxx や __reactProps$xxx のような形式を使用
     */
    function getReactInternals(element) {
        const keys = Object.keys(element);
        const fiberKey = keys.find(k => k.startsWith("__reactFiber$"));
        const propsKey = keys.find(k => k.startsWith("__reactProps$"));

        return {
            fiber: fiberKey ? element[fiberKey] : null,
            props: propsKey ? element[propsKey] : null
        };
    }

    /**
     * オブジェクトから動画情報を含むmediaを探す（深さ優先探索）
     */
    function findMediaInObject(obj, visited = new WeakSet(), depth = 0) {
        if (!obj || typeof obj !== 'object' || depth > 30 || visited.has(obj)) {
            return null;
        }

        try {
            visited.add(obj);
        } catch (e) {
            // WeakSetに追加できないオブジェクト（プリミティブなど）は無視
        }

        // 動画情報を含むmediaを見つけた場合
        if (obj.video_info && obj.video_info.variants) {
            log("Found video_info directly:", obj);
            return [obj];
        }

        // extended_entities.media を見つけた場合
        if (obj.extended_entities?.media) {
            const media = obj.extended_entities.media;
            if (Array.isArray(media) && media.some(m => m.video_info)) {
                log("Found extended_entities.media:", media);
                return media;
            }
        }

        // legacy.extended_entities.media を見つけた場合（GraphQL API形式）
        if (obj.legacy?.extended_entities?.media) {
            const media = obj.legacy.extended_entities.media;
            if (Array.isArray(media) && media.some(m => m.video_info)) {
                log("Found legacy.extended_entities.media:", media);
                return media;
            }
        }

        // tweet.legacy パターン
        if (obj.tweet?.legacy?.extended_entities?.media) {
            const media = obj.tweet.legacy.extended_entities.media;
            if (Array.isArray(media) && media.some(m => m.video_info)) {
                log("Found tweet.legacy.extended_entities.media:", media);
                return media;
            }
        }

        // result.legacy パターン（TweetResultsなど）
        if (obj.result?.legacy?.extended_entities?.media) {
            const media = obj.result.legacy.extended_entities.media;
            if (Array.isArray(media) && media.some(m => m.video_info)) {
                log("Found result.legacy.extended_entities.media:", media);
                return media;
            }
        }

        // 再帰探索（優先度の高いキーから）
        const priorityKeys = [
            'tweet', 'result', 'legacy', 'data', 'tweetResult',
            'media', 'extended_entities', 'entities',
            'props', 'children', 'memoizedProps', 'memoizedState',
            'stateNode', 'return', 'child'
        ];

        for (const key of priorityKeys) {
            if (obj[key] !== undefined) {
                const result = findMediaInObject(obj[key], visited, depth + 1);
                if (result) return result;
            }
        }

        // その他のキーも探索
        for (const key of Object.keys(obj)) {
            if (priorityKeys.includes(key)) continue;
            if (key.startsWith('_') && !key.startsWith('__react')) continue;

            try {
                const value = obj[key];
                if (value && typeof value === 'object') {
                    const result = findMediaInObject(value, visited, depth + 1);
                    if (result) return result;
                }
            } catch (e) {
                // アクセス不可のプロパティは無視
            }
        }

        return null;
    }

    /**
     * オブジェクトからツイートメタ（username/text/id）を探す
     */
    function findTweetMetaInObject(obj, visited = new WeakSet(), depth = 0) {
        if (!obj || typeof obj !== 'object' || depth > 30 || visited.has(obj)) {
            return null;
        }

        try {
            visited.add(obj);
        } catch (e) {
            // ignore
        }

        const meta = {};

        const user = obj.user || obj.core?.user_results?.result?.legacy?.user || obj.core?.user_results?.result || null;
        const legacyUser = user?.legacy || user;
        if (legacyUser?.screen_name) meta.username = legacyUser.screen_name;
        if (legacyUser?.name) meta.displayName = legacyUser.name;

        const legacy = obj.legacy || obj.tweet?.legacy || obj.result?.legacy || obj.tweetResult?.result?.legacy;
        if (legacy?.full_text) meta.text = legacy.full_text;
        if (legacy?.text && !meta.text) meta.text = legacy.text;

        if (obj.id_str) meta.tweetId = obj.id_str;
        if (obj.rest_id && !meta.tweetId) meta.tweetId = obj.rest_id;
        if (legacy?.id_str && !meta.tweetId) meta.tweetId = legacy.id_str;

        if (meta.username || meta.text || meta.tweetId) {
            log("Found tweet meta:", meta);
            return meta;
        }

        // 探索キー優先度
        const priorityKeys = [
            'tweet', 'result', 'legacy', 'data', 'tweetResult',
            'core', 'user', 'user_results', 'result', 'rest_id',
            'props', 'children', 'memoizedProps', 'memoizedState',
            'stateNode', 'return', 'child'
        ];

        for (const key of priorityKeys) {
            if (obj[key] !== undefined) {
                const result = findTweetMetaInObject(obj[key], visited, depth + 1);
                if (result) return result;
            }
        }

        for (const key of Object.keys(obj)) {
            if (priorityKeys.includes(key)) continue;
            if (key.startsWith('_') && !key.startsWith('__react')) continue;

            try {
                const value = obj[key];
                if (value && typeof value === 'object') {
                    const result = findTweetMetaInObject(value, visited, depth + 1);
                    if (result) return result;
                }
            } catch (e) {
                // ignore
            }
        }

        return null;
    }

    /**
     * React Fiberツリーを上方向に辿ってツイートデータを探す
     */
    function findMediaFromFiber(fiber, maxUp = 20) {
        let current = fiber;
        let upCount = 0;

        while (current && upCount < maxUp) {
            // memoizedPropsを確認
            if (current.memoizedProps) {
                const media = findMediaInObject(current.memoizedProps, new WeakSet(), 0);
                if (media) {
                    log("Found media in memoizedProps at level", upCount);
                    return media;
                }
            }

            // memoizedStateを確認（Hooksの状態）
            if (current.memoizedState) {
                const media = findMediaInObject(current.memoizedState, new WeakSet(), 0);
                if (media) {
                    log("Found media in memoizedState at level", upCount);
                    return media;
                }
            }

            // pendingPropsも確認
            if (current.pendingProps) {
                const media = findMediaInObject(current.pendingProps, new WeakSet(), 0);
                if (media) {
                    log("Found media in pendingProps at level", upCount);
                    return media;
                }
            }

            current = current.return;
            upCount++;
        }

        return null;
    }

    function findMetaFromFiber(fiber, maxUp = 20) {
        let current = fiber;
        let upCount = 0;

        while (current && upCount < maxUp) {
            if (current.memoizedProps) {
                const meta = findTweetMetaInObject(current.memoizedProps, new WeakSet(), 0);
                if (meta) return meta;
            }
            if (current.memoizedState) {
                const meta = findTweetMetaInObject(current.memoizedState, new WeakSet(), 0);
                if (meta) return meta;
            }
            if (current.pendingProps) {
                const meta = findTweetMetaInObject(current.pendingProps, new WeakSet(), 0);
                if (meta) return meta;
            }

            current = current.return;
            upCount++;
        }

        return null;
    }

    /**
     * 最高画質の動画URLを取得
     */
    function getHighestQualityVideoUrl(mediaEntities) {
        let bestUrl = null;
        let maxBitrate = -1;

        for (const media of mediaEntities) {
            if (media.type === "video" || media.type === "animated_gif") {
                const variants = media.video_info?.variants;
                if (variants) {
                    for (const variant of variants) {
                        // MP4形式を優先
                        if (variant.content_type === "video/mp4") {
                            const bitrate = variant.bitrate || 0;
                            if (bitrate > maxBitrate) {
                                maxBitrate = bitrate;
                                bestUrl = variant.url;
                            }
                        }
                    }
                    // bitrateがない場合（GIFなど）は最初のMP4を使用
                    if (!bestUrl) {
                        const mp4 = variants.find(v => v.content_type === "video/mp4");
                        if (mp4) bestUrl = mp4.url;
                    }
                }
            }
        }

        log("Best video URL:", bestUrl, "Bitrate:", maxBitrate);
        return bestUrl;
    }

    function getVideoUrlFromDom(article) {
        const videoEl = article.querySelector('video');
        if (!videoEl) return null;

        if (videoEl.currentSrc && videoEl.currentSrc.includes('.mp4')) {
            log("Using video.currentSrc directly:", videoEl.currentSrc);
            return videoEl.currentSrc;
        }
        if (videoEl.src && videoEl.src.includes('.mp4')) {
            log("Using video.src directly:", videoEl.src);
            return videoEl.src;
        }

        const sourceEl = videoEl.querySelector('source');
        if (sourceEl?.src && sourceEl.src.includes('.mp4')) {
            log("Using video source src directly:", sourceEl.src);
            return sourceEl.src;
        }

        return null;
    }

    /**
     * ツイートarticle要素から動画URLを抽出
     */
    function extractVideoUrl(article) {
        const { fiber, props } = getReactInternals(article);

        log("React internals - fiber:", !!fiber, "props:", !!props);

        // 方法1: Fiberツリーから探索
        if (fiber) {
            const media = findMediaFromFiber(fiber);
            if (media) {
                return getHighestQualityVideoUrl(media);
            }
        }

        // 方法2: Propsから直接探索
        if (props) {
            const media = findMediaInObject(props, new WeakSet(), 0);
            if (media) {
                return getHighestQualityVideoUrl(media);
            }
        }

        // 方法3: DOMから直接取得
        const domUrl = getVideoUrlFromDom(article);
        if (domUrl) return domUrl;

        // 方法4: article内の全要素を探索
        const allElements = article.querySelectorAll('*');
        for (const el of allElements) {
            const { fiber: elFiber } = getReactInternals(el);
            if (elFiber) {
                const media = findMediaFromFiber(elFiber, 10);
                if (media) {
                    return getHighestQualityVideoUrl(media);
                }
            }
        }

        // 方法5: video要素からFiber探索
        const videoEl = article.querySelector('video');
        if (videoEl) {
            const { fiber: videoFiber } = getReactInternals(videoEl);
            if (videoFiber) {
                const media = findMediaFromFiber(videoFiber, 20);
                if (media) {
                    return getHighestQualityVideoUrl(media);
                }
            }
        }

        return null;
    }

    function extractTweetMeta(article) {
        const { fiber, props } = getReactInternals(article);

        if (fiber) {
            const meta = findMetaFromFiber(fiber, 20);
            if (meta) return meta;
        }

        if (props) {
            const meta = findTweetMetaInObject(props, new WeakSet(), 0);
            if (meta) return meta;
        }

        const allElements = article.querySelectorAll('*');
        for (const el of allElements) {
            const { fiber: elFiber } = getReactInternals(el);
            if (elFiber) {
                const meta = findMetaFromFiber(elFiber, 10);
                if (meta) return meta;
            }
        }

        return null;
    }

    // Listen for requests from Content Script
    window.addEventListener("message", (event) => {
        if (event.source !== window) return;

        if (event.data.type === "TWI_HAI_GET_VIDEO_URL") {
            const { tweetId, requestId } = event.data;
            log("Received request for tweet:", tweetId);

            const article = document.querySelector(`article[data-twi-hai-id="${tweetId}"]`);

            if (!article) {
                window.postMessage({
                    type: "TWI_HAI_VIDEO_URL_RESULT",
                    error: "Article not found",
                    tweetId,
                    requestId
                }, "*");
                return;
            }

            try {
                const videoUrl = extractVideoUrl(article);
                const tweetMeta = extractTweetMeta(article) || {};

                if (videoUrl) {
                    window.postMessage({
                        type: "TWI_HAI_VIDEO_URL_RESULT",
                        url: videoUrl,
                        tweetId,
                        requestId,
                        tweetMeta
                    }, "*");
                } else {
                    window.postMessage({
                        type: "TWI_HAI_VIDEO_URL_RESULT",
                        error: "No video URL found. Check console for debug info.",
                        tweetId,
                        requestId,
                        tweetMeta
                    }, "*");
                }
            } catch (err) {
                log("Error extracting video:", err);
                window.postMessage({
                    type: "TWI_HAI_VIDEO_URL_RESULT",
                    error: "Error: " + err.message,
                    tweetId,
                    requestId,
                    tweetMeta: {}
                }, "*");
            }
        }
    });

})();
