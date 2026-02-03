// background.js

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "download_video") {
    const url = request.url;
    const filename = request.filename || "twitter_video.mp4";

    chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error("Download failed:", chrome.runtime.lastError);
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        console.log("Download started with ID:", downloadId);
        sendResponse({ success: true, downloadId: downloadId });
      }
    });

    return true; // Keep the message channel open for async response
  }
});
