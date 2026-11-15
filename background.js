const APPLY = { type: 'essence:apply' };

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  try {
    // essence.js is already running as a content script and has been
    // tracking the page's content since it started loading.
    await chrome.tabs.sendMessage(tab.id, APPLY);
  } catch {
    // No content script in this tab (e.g. the tab was open before the
    // extension was installed/reloaded). Inject it now; it will only see
    // the content currently on the page.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        files: ['themes.js', 'essence.js']
      });
      await chrome.tabs.sendMessage(tab.id, APPLY);
    } catch (err) {
      // Restricted pages (chrome://, Web Store, etc.) can't be scripted.
      console.warn('Essence could not run on this tab:', err);
    }
  }
});
