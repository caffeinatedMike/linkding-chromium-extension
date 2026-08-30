document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('options-form');
  const linkdingUrlInput = document.getElementById('linkding-url');
  const apiTokenInput = document.getElementById('api-token');
  const statusDiv = document.getElementById('status');
  const syncBtn = document.getElementById('sync-btn');
  const syncStatusDiv = document.getElementById('sync-status');
  const displayModeRadios = document.querySelectorAll('input[name="display-mode"]');
  const showTagsCheckbox = document.getElementById('show-tags');
  const showActionsCheckbox = document.getElementById('show-actions');
  const sidePanelShowTagsCheckbox = document.getElementById('side-panel-show-tags');
  const sidePanelShowActionsCheckbox = document.getElementById('side-panel-show-actions');

  // --- Bookmarks Sync Logic ---

  const SYNC_FOLDER_TITLE = 'Linkding Bookmarks';

  function groupBookmarksByTag(bookmarks) {
      const bookmarksByTag = {};
      bookmarks.forEach(bookmark => {
          const tags = bookmark.tag_names.length > 0 ? bookmark.tag_names : ['[Untagged]'];
          tags.forEach(tag => {
              if (!bookmarksByTag[tag]) bookmarksByTag[tag] = [];
              bookmarksByTag[tag].push(bookmark);
          });
      });
      return bookmarksByTag;
  }

  function buildTagTree(tags) {
      const tree = {};
      tags.forEach(tag => {
          let currentNode = tree;
          const parts = tag.split('.');
          parts.forEach((part, index) => {
              if (!currentNode[part]) {
                  currentNode[part] = { __children: {} };
              }
              if (index === parts.length - 1) {
                  currentNode[part].__isTag = true;
                  currentNode[part].__fullName = tag;
              }
              currentNode = currentNode[part].__children;
          });
      });
      return tree;
  }

  async function findAndDeleteSyncFolder() {
      const results = await chrome.bookmarks.search({ title: SYNC_FOLDER_TITLE });
      for (const bookmark of results) {
          // Ensure it's a folder on the bookmarks bar ('1') or in "Other Bookmarks" ('2')
          if (!bookmark.url && (bookmark.parentId === '1' || bookmark.parentId === '2')) {
              await chrome.bookmarks.removeTree(bookmark.id);
          }
      }
  }

  async function createBookmarksRecursive(parentId, treeNode, bookmarksByTag) {
      const sortedKeys = Object.keys(treeNode).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      for (const key of sortedKeys) {
          const node = treeNode[key];
          const folder = await chrome.bookmarks.create({ parentId, title: key });

          if (node.__isTag && node.__fullName) {
              const bookmarksForTag = bookmarksByTag[node.__fullName] || [];
              for (const bookmark of bookmarksForTag) {
                  await chrome.bookmarks.create({ parentId: folder.id, title: bookmark.title || bookmark.website_title || bookmark.url, url: bookmark.url });
              }
          }
          if (Object.keys(node.__children).length > 0) {
              await createBookmarksRecursive(folder.id, node.__children, bookmarksByTag);
          }
      }
  }

  // Builds a throwaway LinkdingApi client from form values, rather than
  // chrome.storage, since the user may be testing/saving credentials
  // that haven't been persisted yet.
  async function testConnection(url, token) {
    try {
      const api = new LinkdingApi({ baseUrl: url, token });
      await api.get('/api/');
      return true;
    } catch (error) {
      return false;
    }
  }

  async function saveOptions(e) {
    e.preventDefault();
    const url = linkdingUrlInput.value.trim().replace(/\/$/, '');
    const token = apiTokenInput.value.trim();

    const isConnected = await testConnection(url, token);

    if (isConnected) {
      chrome.storage.sync.set({
        linkdingUrl: url,
        apiToken: token
      }, () => {
        statusDiv.textContent = 'Options saved and connection successful!';
        statusDiv.className = '';
        setTimeout(() => { statusDiv.textContent = ''; }, 3000);
      });
    } else {
      statusDiv.textContent = 'Connection failed. Please check your URL and API Token.';
      statusDiv.className = 'warning';
    }
  }

  function saveUiSettings() {
    chrome.storage.sync.set({
      showTags: showTagsCheckbox.checked,
      showActions: showActionsCheckbox.checked,
    });
  }

  function saveSidePanelUiSettings() {
    chrome.storage.sync.set({
      sidePanelShowTags: sidePanelShowTagsCheckbox.checked,
      sidePanelShowActions: sidePanelShowActionsCheckbox.checked,
    });
  }

  async function restoreOptions() {
    const {
      linkdingUrl,
      apiToken,
      displayMode = 'popup',
      showTags = true,
      showActions = true,
      sidePanelShowTags = true,
      sidePanelShowActions = true
    } = await chrome.storage.sync.get({
      linkdingUrl: '',
      apiToken: '',
      displayMode: 'popup',
      showTags: true,
      showActions: true,
      sidePanelShowTags: true,
      sidePanelShowActions: true,
    });

    if (linkdingUrl) linkdingUrlInput.value = linkdingUrl;
    if (apiToken) apiTokenInput.value = apiToken;

    const selectedRadio = document.querySelector(`input[name="display-mode"][value="${displayMode}"]`);
    if (selectedRadio) selectedRadio.checked = true;

    showTagsCheckbox.checked = showTags;
    showActionsCheckbox.checked = showActions;

    sidePanelShowTagsCheckbox.checked = sidePanelShowTags;
    sidePanelShowActionsCheckbox.checked = sidePanelShowActions;
  }

  async function syncToBookmarksBar() {
    syncBtn.disabled = true;
    syncStatusDiv.className = '';
    syncStatusDiv.textContent = 'Syncing... Step 1/4: Fetching bookmarks...';

    try {
        // Goes through the shared Linkding facade so this sync uses the
        // same cache that the popup/side panel read from, and forces a
        // refresh so we always sync against current data.
        const linkding = await createLinkding();
        const allBookmarks = await linkding.getBookmarks({ forceRefresh: true });

        syncStatusDiv.textContent = `Syncing... Step 2/4: Processing ${allBookmarks.length} bookmarks...`;
        const bookmarksByTag = groupBookmarksByTag(allBookmarks);
        const tagTree = buildTagTree(Object.keys(bookmarksByTag));

        syncStatusDiv.textContent = 'Syncing... Step 3/4: Cleaning up old bookmarks folder...';
        await findAndDeleteSyncFolder();

        syncStatusDiv.textContent = 'Syncing... Step 4/4: Creating new bookmarks folder...';
        const newRootFolder = await chrome.bookmarks.create({ parentId: '1', title: SYNC_FOLDER_TITLE });
        await createBookmarksRecursive(newRootFolder.id, tagTree, bookmarksByTag);

        syncStatusDiv.textContent = 'Sync complete! "Linkding Bookmarks" folder created on your bookmarks bar.';
        setTimeout(() => { syncStatusDiv.textContent = ''; }, 5000);
    } catch (error) {
        syncStatusDiv.textContent = `Error during sync: ${error.message}`;
        syncStatusDiv.className = 'warning';
    } finally {
        syncBtn.disabled = false;
    }
  }

  form.addEventListener('submit', saveOptions);
  syncBtn.addEventListener('click', syncToBookmarksBar);

  displayModeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => chrome.storage.sync.set({ displayMode: e.target.value }));
  });

  showTagsCheckbox.addEventListener('change', saveUiSettings);
  showActionsCheckbox.addEventListener('change', saveUiSettings);

  sidePanelShowTagsCheckbox.addEventListener('change', saveSidePanelUiSettings);
  sidePanelShowActionsCheckbox.addEventListener('change', saveSidePanelUiSettings);

  restoreOptions();
});
