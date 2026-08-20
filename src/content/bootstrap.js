/**
 * Content scripts cannot be ES modules, but they can dynamically import one.
 *
 * That is the whole reason this file exists: it keeps the real code as plain
 * ESM that the node tests can import directly, with no bundler in the project.
 */

(async () => {
  try {
    await import(chrome.runtime.getURL('src/content/main.js'));
  } catch (error) {
    console.error('[pvg] failed to start', error);
  }
})();
