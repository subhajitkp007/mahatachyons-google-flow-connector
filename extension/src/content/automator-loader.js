(async () => {
  await import(chrome.runtime.getURL("src/content/automator.js"));
})();

