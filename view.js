document.addEventListener('DOMContentLoaded', () => {
    const bookmarksList = document.getElementById('bookmarks-list');
    const loadingMessage = document.getElementById('loading-message');
    const errorMessage = document.getElementById('error-message');
    const searchBox = document.getElementById('search-box');
    const addTabBtn = document.getElementById('add-tab-btn');
    const refreshBtn = document.getElementById('refresh-btn');
    const addStatus = document.getElementById('add-status');
    const addStatusMessage = document.getElementById('add-status-message');
    const addStatusDismiss = document.getElementById('add-status-dismiss');
    const openManagerBtn = document.getElementById('open-manager-btn');

    let allBookmarksFlat = [];
    let allBookmarksByTag = {};
    let allTags = [];
    let config = {};
    let linkding = null;

    function showError(message, showOptionsLink = false) {
        loadingMessage.classList.add('hidden');
        if (showOptionsLink) {
            const optionsUrl = chrome.runtime.getURL('options.html');
            errorMessage.innerHTML = `${message} Please <a href="${optionsUrl}" target="_blank">configure the extension</a>.`;
            // Add event listener to open options page
            errorMessage.querySelector('a').addEventListener('click', (e) => {
                e.preventDefault();
                chrome.runtime.openOptionsPage();
            });
        } else {
            errorMessage.textContent = message;
        }
        errorMessage.classList.remove('hidden');
    }

    // --- DOM & Rendering ---

    function escapeHTML(str) {
        if (str === null || str === undefined) return '';
        const p = document.createElement('p');
        p.textContent = str;
        return p.innerHTML;
    }

    function createTagAutocomplete(input, container) {
        const suggestionsDiv = document.createElement('div');
        suggestionsDiv.className = 'tag-suggestions hidden';
        container.appendChild(suggestionsDiv);

        input.addEventListener('input', () => {
            const terms = input.value.split(',').map(t => t.trim());
            const currentTerm = terms[terms.length - 1].toLowerCase();

            if (!currentTerm) {
                suggestionsDiv.classList.add('hidden');
                return;
            }

            const filteredTags = allTags.filter(tag => tag.toLowerCase().startsWith(currentTerm) && !terms.includes(tag));
            suggestionsDiv.innerHTML = '';

            if (filteredTags.length > 0) {
                suggestionsDiv.classList.remove('hidden');
                filteredTags.forEach(tag => {
                    const item = document.createElement('div');
                    item.className = 'tag-suggestion-item';
                    item.textContent = tag;
                    item.addEventListener('click', () => {
                        terms[terms.length - 1] = tag;
                        input.value = terms.join(', ') + ', ';
                        suggestionsDiv.classList.add('hidden');
                        input.focus();
                    });
                    suggestionsDiv.appendChild(item);
                });
            } else {
                suggestionsDiv.classList.add('hidden');
            }
        });
    }

    function createBookmarkElement(bookmark, sourceTag) {
        const li = document.createElement('li');
        li.dataset.bookmarkId = bookmark.id;

        const contentDiv = document.createElement('div');
        contentDiv.className = 'bookmark-content';

        const infoDiv = document.createElement('div');
        infoDiv.className = 'bookmark-info';

        const a = document.createElement('a');
        a.href = bookmark.url;
        a.target = '_blank';

        const title =
            bookmark.title ||
            bookmark.website_title ||
            'No Title';

        a.textContent = title;

        let tooltip = `${title}\n${bookmark.url}`;
        if (bookmark.description) {
            tooltip += `\n\n---\n${bookmark.description}`;
        }

        a.title = tooltip;
        infoDiv.appendChild(a);
        contentDiv.appendChild(infoDiv);

        if (config.showTags) {
            const tagsDiv = document.createElement('div');
            tagsDiv.className = 'bookmark-tags';
            if (bookmark.tag_names.length > 0) {
                bookmark.tag_names.forEach(tagName => {
                    const tagItem = document.createElement('span');
                    tagItem.className = 'tag-item';
                    tagItem.textContent = tagName;

                    if (config.showActions) {
                        const removeBtn = document.createElement('button');
                        removeBtn.className = 'remove-tag-btn';
                        removeBtn.innerHTML = '&times;';
                        removeBtn.title = `Remove tag: ${tagName}`;
                        removeBtn.addEventListener('click', async () => {
                            const updatedTags = bookmark.tag_names.filter(
                                t => t !== tagName
                            );
                            try {
                                const updatedBookmark = await linkding.updateBookmark(
                                    bookmark.id, {...bookmark, tag_names: updatedTags}
                                );
                                const index = allBookmarksFlat.findIndex(b => b.id === bookmark.id);
                                if (index !== -1) allBookmarksFlat[index] = updatedBookmark;
                                reRenderUI();
                            } catch (error) {
                                alert(`An error occurred: ${error.message}`);
                            }
                        });
                        tagItem.appendChild(removeBtn);
                    }
                    tagsDiv.appendChild(tagItem);
                });
            }
            contentDiv.appendChild(tagsDiv);
        }

        li.appendChild(contentDiv);

        if (config.showActions) {
            li.draggable = true;

            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'bookmark-actions';

            const editBtn = document.createElement('button');
            editBtn.title = 'Edit';
            editBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
            editBtn.addEventListener('click', () => {
                editBtn.disabled = true;

                BookmarkForm.open({
                    container: bookmarkFormRoot,
                    bookmark,
                    linkding,
                    allTags,
                    onSaved: (updatedBookmark) => {
                        applySavedBookmark(updatedBookmark);
                        showAddStatus('Bookmark updated successfully!');
                    },
                    onClosed: () => {
                        editBtn.disabled = false;
                    },
                });
            });

            const deleteBtn = document.createElement('button');
            deleteBtn.title = 'Delete';
            deleteBtn.className = 'delete-btn';
            deleteBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
            deleteBtn.addEventListener('click', async () => {
                if (confirm(`Are you sure you want to delete "${title}"?`)) {
                    try {
                        await linkding.deleteBookmark(bookmark.id);
                        allBookmarksFlat = allBookmarksFlat.filter(b => b.id !== bookmark.id);
                        reRenderUI();
                    } catch (error) {
                        alert(`An error occurred: ${error.message}`);
                    }
                }
            });

            actionsDiv.appendChild(editBtn);
            actionsDiv.appendChild(deleteBtn);
            li.appendChild(actionsDiv);

            li.addEventListener('dragstart', (e) => {
                const payload = { id: bookmark.id, sourceTag: sourceTag };
                e.dataTransfer.setData('application/json', JSON.stringify(payload));
                e.dataTransfer.effectAllowed = 'move';
                setTimeout(() => li.classList.add('dragging'), 0);
            });

            li.addEventListener('dragend', () => {
                li.classList.remove('dragging');
            });
        }
        return li;
    }

    function renderFoldersAndBookmarks(bookmarksByTag) {
        bookmarksList.innerHTML = ''; // Clear previous content
        if (Object.keys(bookmarksByTag).length === 0) {
            bookmarksList.innerHTML = '<p class="empty-state">No bookmarks found.</p>';
            return;
        }

        const tagTree = buildTagTree(Object.keys(bookmarksByTag));
        renderFolderTree(tagTree, bookmarksList, bookmarksByTag);
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

    function renderFolderTree(
        node,
        container,
        bookmarksByTag,
        path = []
    ) {
        const sortedKeys = Object.keys(node).sort(
            (a, b) => a.toLowerCase().localeCompare(b.toLowerCase())
        );

        for (const key of sortedKeys) {
            const currentPath = [...path, key];
            const tagNode = node[key];
            const folderItem = document.createElement('div');
            folderItem.className = 'folder-item';
            const potentialTagName = currentPath.join('.');
            folderItem.dataset.tag = potentialTagName;

            const folderLabel = document.createElement('div');
            folderLabel.className = 'folder-label';

            if (config.showActions) {
                folderLabel.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    folderItem.classList.add('drag-over');
                    e.dataTransfer.dropEffect = 'move';
                });

                folderLabel.addEventListener('dragleave', () => {
                    folderItem.classList.remove('drag-over');
                });

                folderLabel.addEventListener('drop', async (e) => {
                    e.preventDefault();
                    folderItem.classList.remove('drag-over');

                    const payload = JSON.parse(e.dataTransfer.getData('application/json'));
                    const bookmarkId = payload.id;
                    const sourceTag = payload.sourceTag;
                    const targetTag = folderItem.dataset.tag;
                    if (!targetTag || sourceTag === targetTag) {
                        return; // Don't drop on itself or invalid target
                    }

                    const bookmarkToMove = allBookmarksFlat.find(b => b.id === bookmarkId);
                    if (!bookmarkToMove) return;

                    const newTags = bookmarkToMove.tag_names.filter(t => t !== sourceTag);
                    if (!newTags.includes(targetTag)) {
                        newTags.push(targetTag);
                    }

                    try {
                        const updatedBookmark = await linkding.updateBookmark(
                            bookmarkId, { ...bookmarkToMove, tag_names: newTags }
                        );
                        const index = allBookmarksFlat.findIndex(b => b.id === bookmarkId);
                        if (index !== -1) allBookmarksFlat[index] = updatedBookmark;
                        reRenderUI();
                    } catch (error) {
                        alert(`An error occurred: ${error.message}`);
                    }
                });
            }

            const hasChildren = Object.keys(tagNode.__children).length > 0;

            if (hasChildren) {
                const toggle = document.createElement('span');
                toggle.className = 'folder-toggle';
                folderLabel.appendChild(toggle);
            }

            const folderName = document.createElement('span');
            folderName.className = 'folder-name';
            folderName.textContent = key;
            folderLabel.appendChild(folderName);
            folderItem.appendChild(folderLabel);

            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'folder-children';

            if (hasChildren) {
                renderFolderTree(
                    tagNode.__children,
                    childrenContainer,
                    bookmarksByTag,
                    currentPath
                );
            }

            if (tagNode.__isTag) {
                const bookmarks = bookmarksByTag[tagNode.__fullName] || [];
                const ul = document.createElement('ul');
                bookmarks.forEach(bookmark => ul.appendChild(createBookmarkElement(bookmark, tagNode.__fullName)));
                const folderContent = document.createElement('div');
                folderContent.className = 'folder-content';
                folderContent.appendChild(ul);
                childrenContainer.appendChild(folderContent);
            }

            folderItem.appendChild(childrenContainer);
            folderLabel.addEventListener('click', () => folderItem.classList.toggle('open'));
            container.appendChild(folderItem);
        }
    }

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

    function filterAndRender(searchTerm) {
        const lowerCaseSearchTerm = searchTerm.toLowerCase().trim();
        if (!lowerCaseSearchTerm) {
            renderFoldersAndBookmarks(allBookmarksByTag);
            return;
        }

        const filteredBookmarksByTag = {};
        for (const tag in allBookmarksByTag) {
            const matchingBookmarks = allBookmarksByTag[tag].filter(b =>
                (b.title?.toLowerCase().includes(lowerCaseSearchTerm)) ||
                (b.website_title?.toLowerCase().includes(lowerCaseSearchTerm)) ||
                (b.description?.toLowerCase().includes(lowerCaseSearchTerm)) ||
                (b.url?.toLowerCase().includes(lowerCaseSearchTerm)) ||
                b.tag_names.some(t => t.toLowerCase().includes(lowerCaseSearchTerm))
            );
            if (matchingBookmarks.length > 0) {
                filteredBookmarksByTag[tag] = matchingBookmarks;
            }
        }
        renderFoldersAndBookmarks(filteredBookmarksByTag);
        // When searching, all folders should be open by default to show results
        document.querySelectorAll('.folder-item').forEach(folder => folder.classList.add('open'));
    }

    function reRenderUI() {
        // 1. Preserve the open/closed state of folders before re-rendering
        const openFolderTags = new Set();
        document.querySelectorAll('#bookmarks-container .folder-item.open').forEach(folder => {
            if (folder.dataset.tag) {
                openFolderTags.add(folder.dataset.tag);
            }
        });

        // 2. Re-calculate derived data from the master list
        allBookmarksByTag = groupBookmarksByTag(allBookmarksFlat);
        allTags = [...new Set(allBookmarksFlat.flatMap(b => b.tag_names))].sort();

        // 3. Render the entire folder tree
        renderFoldersAndBookmarks(allBookmarksByTag);

        // 4. Now that the folders are in the DOM, restore their open state.
        if (openFolderTags.size > 0) {
            openFolderTags.forEach(tag => {
                // This logic ensures parent folders are also opened.
                const parts = tag.split('.');
                let currentPath = '';
                parts.forEach(part => {
                    currentPath = currentPath ? `${currentPath}.${part}` : part;
                    const folderToOpen = document.querySelector(`#bookmarks-container .folder-item[data-tag="${currentPath}"]`);
                    if (folderToOpen) folderToOpen.classList.add('open');
                });
            });
        }
    }

    function showAddStatus(message, isError = false) {
        isError ? addStatus.classList.add('error') : addStatus.classList.remove('error');
        addStatusMessage.textContent = message;
        addStatus.classList.remove('hidden');
        if (isError) {
            addStatusDismiss.addEventListener('click', () => {
                addStatus.classList.add('hidden');
            });
        } else {
            setTimeout(() => {
                addStatus.classList.add('hidden');
            }, 3000);
        }

    }

    // Bookmark Operations

    const bookmarkFormRoot = document.getElementById('bookmark-form-root');

    function applySavedBookmark(bookmark) {
        const index = allBookmarksFlat.findIndex(b => b.id === bookmark.id);
        if (index !== -1) {
            allBookmarksFlat[index] = bookmark;
        } else {
            allBookmarksFlat.push(bookmark);
        }
        reRenderUI();
    }

    async function openAddCurrentTabForm() {
        try {
            const [tab] = await chrome.tabs.query({
                active: true,
                currentWindow: true,
            });

            if (!tab || !tab.url) {
                showAddStatus('Could not locate active tab with a valid url.', true);
                return;
            }

            BookmarkForm.open({
                container: bookmarkFormRoot,
                url: tab.url,
                title: tab.title,
                linkding,
                allTags,
                onSaved: (bookmark, mode) => {
                    applySavedBookmark(bookmark);
                    showAddStatus(
                        mode === 'created'
                            ? 'Bookmark added successfully!'
                            : 'Bookmark updated successfully!'
                    );
                },
            });
        } catch (error) {
            showAddStatus(`Error: ${error.message}`, true);
        }
    }

    // How long a pending "open the add form" request (see background.js)
    // stays valid. Generous, since if we can't force the popup open
    // immediately, the fallback is simply "show the form the next time
    // the popup opens for any reason" — the user may take a moment to
    // click the icon themselves.
    const PENDING_ADD_LINK_TTL_MS = 5 * 60 * 1000;

    async function openPendingAddFormIfAny() {
        try {
            // Read both keys we care about.
            const { pendingAddLink, activeBookmarkForm } = await chrome.storage.session.get(['pendingAddLink', 'activeBookmarkForm']);

            // 1) Handle pendingAddLink (context-menu/open-from-background flow).
            if (pendingAddLink) {
                // Consume the request so it cannot be opened twice.
                await chrome.storage.session.remove('pendingAddLink');

                if (
                    !pendingAddLink.ts ||
                    Date.now() - pendingAddLink.ts > PENDING_ADD_LINK_TTL_MS
                ) {
                    // stale
                } else {
                    // If the request is for a different tab, ignore it.
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (tab?.id && tab.id === pendingAddLink.tabId) {
                        linkding = linkding || await createLinkding();

                        BookmarkForm.open({
                            container: bookmarkFormRoot,
                            url: pendingAddLink.url,
                            title: pendingAddLink.title || '',
                            linkding,
                            allTags,
                            onSaved: (bookmark, mode) => {
                                applySavedBookmark(bookmark);
                                showAddStatus(
                                    mode === 'created'
                                        ? 'Bookmark added successfully!'
                                        : 'Bookmark updated successfully!'
                                );
                            },
                        });
                        // Return early because we've opened a form for the pending add.
                        return;
                    }
                }
            }

            // 2) Handle activeBookmarkForm (manager requested an edit in the side panel).
            if (activeBookmarkForm && activeBookmarkForm.bookmark && activeBookmarkForm.source === 'manager') {
                // If stale abort
                if (!activeBookmarkForm.ts || (Date.now() - activeBookmarkForm.ts) > PENDING_ADD_LINK_TTL_MS) {
                    await chrome.storage.session.remove('activeBookmarkForm');
                    return;
                }

                linkding = linkding || await createLinkding();

                // Open the edit form prefilled with the bookmark object.
                // Provide onSaved and onCancel callbacks that remove the activeBookmarkForm key
                // so the Manager can re-enable its edit button when the form is finished.
                const bookmarkToEdit = activeBookmarkForm.bookmark;

                BookmarkForm.open({
                    container: bookmarkFormRoot,
                    bookmark: bookmarkToEdit,
                    linkding,
                    allTags,
                    onSaved: (savedBookmark, mode) => {
                        applySavedBookmark(savedBookmark);
                        showAddStatus('Bookmark updated successfully!');
                        // Remove the session key to notify Manager to re-enable the button.
                        chrome.storage.session.remove('activeBookmarkForm').catch(() => {});
                    },
                    onCancel: () => {
                        // Remove session key so Manager re-enables button.
                        chrome.storage.session.remove('activeBookmarkForm').catch(() => {});
                    },
                });
            }
        } catch (error) {
            console.warn('Could not check for a pending add/edit request:', error.message);
        }
    }

    // Data Loading

    async function loadData(isForcedRefresh = false) {
        loadingMessage.classList.remove('hidden');
        bookmarksList.innerHTML = '';
        errorMessage.classList.add('hidden');
        if (isForcedRefresh) {
            refreshBtn.disabled = true;
        }

        try {
            const settings = await chrome.storage.sync.get({
                showTags: true,
                showActions: true,
            });
            config = {
                showTags: settings.showTags,
                showActions: settings.showActions,
            };
            linkding = linkding || await createLinkding();
            allBookmarksFlat = await linkding.getBookmarks({ forceRefresh: isForcedRefresh });
            reRenderUI();
        } catch (error) {
            console.error('Error fetching bookmarks:', error);
            const isConfigurationError =
                error.message.includes('Linkding URL') ||
                error.message.includes('API token') ||
                error.message.includes('API Token');

            showError(
                `Failed to load bookmarks. Error: ${error.message}`,
                isConfigurationError
            );
        } finally {
            loadingMessage.classList.add('hidden');
            if (isForcedRefresh) {
                refreshBtn.disabled = false;
            }
        }
    }

    // Main logic to initialize the popup
    async function init() {
        searchBox.addEventListener('input', (e) => filterAndRender(e.target.value));
        addTabBtn.addEventListener('click', openAddCurrentTabForm);
        refreshBtn.addEventListener('click', () => loadData(true));
        openManagerBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: 'manager.html' });
        });

        chrome.storage.onChanged.addListener(
            (changes, namespace) => {
                if (namespace === 'sync'){
                    const uiKeys = ['showTags', 'showActions'];
                    const changedKeys = Object.keys(changes);
                    const hasUiChange = changedKeys.some(key => uiKeys.includes(key));
                    if (hasUiChange) {
                        // A relevant UI setting changed, force a reload of the data and view
                        loadData(true);
                    }
                } else if (namespace === 'session' && (changes?.pendingAddLink?.newValue || changes?.activeBookmarkForm?.newValue)) {
                    openPendingAddFormIfAny();
                }
            }
        );

        chrome.runtime.onMessage.addListener((message) => {
            if (message?.type !== 'linkding-bookmarks-changed') return;
            if (message.reason === 'created' || message.reason === 'updated') {
                message.bookmarks.forEach(bookmark => {
                    const index = allBookmarksFlat.findIndex(b => b.id === bookmark.id);
                    if (index !== -1) {
                        allBookmarksFlat[index] = bookmark;
                    } else {
                        allBookmarksFlat.push(bookmark);
                    }
                });
                reRenderUI();
            } else if (message.reason === 'deleted') {
                const idsToRemove = new Set(message.bookmarkIds);
                allBookmarksFlat = allBookmarksFlat.filter(b => !idsToRemove.has(b.id));
                reRenderUI();
            }
        });

        await loadData(false);
        await openPendingAddFormIfAny();
    }

    init();
});
