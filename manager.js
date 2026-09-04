document.addEventListener('DOMContentLoaded', () => {
    const loadingMessage = document.getElementById('loading-message');
    const bookmarksList = document.getElementById('bookmarks-list');
    const folderListContainer = document.getElementById('folder-list-container');
    const errorMessage = document.getElementById('error-message');
    const searchBox = document.getElementById('search-box');
    const refreshBtn = document.getElementById('refresh-btn');
    const statusBanner = document.getElementById('status-banner');
    const statusMessage = document.getElementById('status-message');
    const statusDismiss = document.getElementById('status-dismiss');

    let allBookmarksByTag = {};
    let tagTree = {};
    let allBookmarksFlat = [];
    let allTags = [];
    let currentTag = null;
    let contextMenu = null;
    let linkding = null;

    function showError(message, showOptionsLink = false) {
        loadingMessage.classList.add('hidden');
        if (showOptionsLink) {
            const optionsUrl = chrome.runtime.getURL('options.html');
            errorMessage.innerHTML = `${message} Please <a href="${optionsUrl}" target="_blank">configure the extension</a>.`;
        } else {
            errorMessage.textContent = message;
        }
        errorMessage.classList.remove('hidden');
    }

    function showStatusBanner(message) {
        statusMessage.textContent = message;
        statusBanner.classList.remove('hidden');
        statusDismiss.addEventListener('click', () => {
            statusBanner.classList.add('hidden');
        });
    }

    function broadcastBookmarkChange(reason, payload) {
        chrome.runtime.sendMessage({
            type: 'linkding-bookmarks-changed',
            reason,
            ...payload,
        }).catch(() => {});
    }

    // --- DOM & Rendering ---

    function createContextMenu() {
        if (contextMenu) document.body.removeChild(contextMenu);

        contextMenu = document.createElement('div');
        contextMenu.className = 'context-menu hidden';
        document.body.appendChild(contextMenu);

        document.addEventListener('click', () => {
            contextMenu.classList.add('hidden');
        });
    }

    async function openEditInSidePanel(bookmark) {
        // Make sure only one Manager edit button is disabled at a time.
        document.querySelectorAll('button[data-editing="true"]').forEach(btn => {
            btn.disabled = false;
            btn.dataset.editing = 'false';
            delete btn.dataset.editingId;
        });

        // Find the edit button for this bookmark so we can disable it while the form is open.
        const li = document.querySelector(`li[data-bookmark-id="${bookmark.id}"]`);
        const editBtn = document.querySelector(`li[data-bookmark-id="${bookmark.id}"] button[title="Edit"]`);
        if (li) li.draggable = false;
        if (editBtn) {
            editBtn.disabled = true;
            editBtn.dataset.editing = 'true';
            editBtn.dataset.editingId = String(bookmark.id);
        }

        try {
            // Open the side panel in the active tab (must call open while user action is active).
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id) {
                try {
                    await chrome.sidePanel.open({ tabId: tab.id });
                } catch (err) {
                    // If sidePanel.open fails we still proceed to set session key so the side panel
                    // will show the form the next time it is opened.
                    console.warn('chrome.sidePanel.open failed', err);
                }
            }

            // Write a session key that the side panel listens for.
            await chrome.storage.session.set({
                activeBookmarkForm: {
                    source: 'manager',
                    bookmark,
                    ts: Date.now(),
                },
            });
        } catch (error) {
            console.error('Could not open edit form in side panel:', error);
            // Re-enable draggable and the edit button on error.
            if (li) li.draggable = true;
            if (editBtn) {
                editBtn.disabled = false;
                editBtn.dataset.editing = 'false';
                delete editBtn.dataset.editingId;
            }
            showStatusBanner('Could not open side panel to edit bookmark.');
        }
    }

    // Add a storage listener so the Manager re-enables any disabled edit buttons
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace !== 'session') return;
        // If activeBookmarkForm was cleared (removed or set to null), re-enable any items we disabled.
        if (changes?.activeBookmarkForm && !changes.activeBookmarkForm.newValue) {
            document.querySelectorAll('li[draggable="false"]').forEach(li => {
                li.draggable = true;
            })
            document.querySelectorAll('button[data-editing="true"]').forEach(btn => {
                btn.disabled = false;
                btn.dataset.editing = 'false';
                delete btn.dataset.editingId;
            });
        }
    });

    async function handleAddFolder(parentTag) {
        const isUntagged = parentTag === '[Untagged]';
        const promptText = isUntagged ?
            'Enter name for new top-level folder:' :
            `Enter name for new subfolder inside "${parentTag}":`;
        const newFolderName = prompt(promptText);
        if (!newFolderName || !newFolderName.trim()) return;
        if (newFolderName.includes('.')) {
            alert('Folder names cannot contain periods.');
            return;
        }

        const newTagName = isUntagged ? newFolderName.trim() : `${parentTag}.${newFolderName.trim()}`;

        if (allBookmarksByTag[newTagName]) {
            alert(`Folder "${newTagName}" already exists.`);
            return;
        }

        // Add to local state and re-render to show immediately.
        // The tag becomes permanent when a bookmark is moved to it.
        allBookmarksByTag[newTagName] = [];
        renderFolders();
    }

    async function handleRenameFolder(fullTag, oldName) {
        const newName = prompt(`Rename "${oldName}" to:`, oldName);
        if (!newName || !newName.trim() || newName === oldName) return;
        if (newName.includes('.')) {
            alert('Folder names cannot contain periods.');
            return;
        }

        const parentPath = fullTag.substring(0, fullTag.lastIndexOf('.'));
        const newFullTag = parentPath ? `${parentPath}.${newName.trim()}` : newName.trim();

        const bookmarksToUpdate = allBookmarksFlat.filter(b => b.tag_names.some(t => t.startsWith(fullTag)));

        if (bookmarksToUpdate.length === 0) {
            allBookmarksByTag[newFullTag] = allBookmarksByTag[fullTag];
            delete allBookmarksByTag[fullTag];
            renderFolders();
            return;
        }

        const updatePromises = bookmarksToUpdate.map(bookmark => {
            const updatedTags = bookmark.tag_names.map(tag => tag.startsWith(fullTag) ? newFullTag + tag.substring(fullTag.length) : tag);
            return linkding.updateBookmark(bookmark.id, { ...bookmark, tag_names: [...new Set(updatedTags)] });
        });

        try {
            const updatedBookmarks = await Promise.all(updatePromises);
            broadcastBookmarkChange('updated', { bookmarks: updatedBookmarks });
            await loadData(true);
        } catch (error) {
            if (error instanceof LinkdingConnectionError) {
                showStatusBanner('Unable to connect to Linkding.');
            } else {
                showStatusBanner(`An error occurred: ${error.message}`)
            }
        }
    }

    async function handleRemoveFolder(fullTag) {
        const bookmarksToUpdate = allBookmarksFlat.filter(b => b.tag_names.some(t => t.startsWith(fullTag)));
        const confirmation = confirm(`Are you sure you want to remove the "${fullTag}" folder and all its sub-folders? This will remove the tag(s) from ${bookmarksToUpdate.length} bookmark(s). This cannot be undone.`);

        if (!confirmation) return;

        if (bookmarksToUpdate.length === 0) {
            delete allBookmarksByTag[fullTag];
            renderFolders();
            return;
        }

        const updatePromises = bookmarksToUpdate.map(bookmark => {
            const updatedTags = bookmark.tag_names.filter(tag => !tag.startsWith(fullTag));
            return linkding.updateBookmark(bookmark.id, { ...bookmark, tag_names: updatedTags });
        });

        try {
            const updatedBookmarks = await Promise.all(updatePromises);
            broadcastBookmarkChange('updated', { bookmarks: updatedBookmarks });
            await loadData(true);
        } catch (error) {
            if (error instanceof LinkdingConnectionError) {
                showStatusBanner('Unable to connect to Linkding.');
            } else {
                showStatusBanner(`An error occurred: ${error.message}`)
            }
        }
    }

    async function handleDrop(e) {
        e.preventDefault();
        const folderItem = e.currentTarget;
        folderItem.classList.remove('drag-over');

        const payload = JSON.parse(e.dataTransfer.getData('application/json'));
        const bookmarkId = payload.id;
        const sourceTag = payload.sourceTag;
        const newTag = folderItem.dataset.tag;

        if (sourceTag === newTag) return;

        const bookmark = allBookmarksFlat.find(b => b.id === bookmarkId);
        if (!bookmark) return;

        let newTags = bookmark.tag_names.filter(t => t !== sourceTag && t !== '[Untagged]');
        if (newTag !== '[Untagged]') {
            newTags.push(newTag);
        }
        const updatedData = { ...bookmark, tag_names: [...new Set(newTags)] };

        try {
            const updatedBookmark = await linkding.updateBookmark(bookmark.id, updatedData);
            broadcastBookmarkChange('updated', { bookmarks: [updatedBookmark] });

            const index = allBookmarksFlat.findIndex(b => b.id === bookmark.id);
            if (index !== -1) allBookmarksFlat[index] = updatedBookmark;
            allBookmarksByTag = groupBookmarksByTag(allBookmarksFlat);

            reRenderUI();
        } catch (error) {
            if (error instanceof LinkdingConnectionError) {
                showStatusBanner('Unable to connect to Linkding.');
            } else {
                showStatusBanner(`An error occurred: ${error.message}`)
            }
        }
    }

    function createBookmarkElement(bookmark, sourceTag) {
        const li = document.createElement('li');
        li.dataset.bookmarkId = bookmark.id;
        li.draggable = true;

        const infoDiv = document.createElement('div');
        infoDiv.className = 'bookmark-info';

        const a = document.createElement('a');
        a.href = bookmark.url;
        a.target = '_blank';
        a.className = 'bookmark-title';

        const title = bookmark.title || bookmark.website_title || 'No Title';
        a.textContent = title;

        let tooltip = `${title}\n${bookmark.url}`;
        if (bookmark.description) {
            tooltip += `\n\n---\n${bookmark.description}`;
        }
        a.title = tooltip;

        const urlSpan = document.createElement('span');
        urlSpan.className = 'bookmark-url';
        urlSpan.textContent = bookmark.url;

        infoDiv.appendChild(a);
        infoDiv.appendChild(urlSpan);

        const tagsDiv = document.createElement('div');
        tagsDiv.className = 'bookmark-tags';

        if (bookmark.tag_names.length > 0) {
            bookmark.tag_names.forEach(tagName => {
                const tagItem = document.createElement('span');
                tagItem.className = 'tag-item';
                tagItem.textContent = tagName;

                const removeBtn = document.createElement('button');
                removeBtn.className = 'remove-tag-btn';
                removeBtn.innerHTML = '&times;';
                removeBtn.title = `Remove tag: ${tagName}`;
                removeBtn.addEventListener('click', async () => {
                    const updatedTags = bookmark.tag_names.filter(t => t !== tagName);
                    try {
                        const updatedBookmark = await linkding.updateBookmark(bookmark.id, { ...bookmark, tag_names: updatedTags });
                        broadcastBookmarkChange('updated', { bookmarks: [updatedBookmark] });

                        const index = allBookmarksFlat.findIndex(b => b.id === bookmark.id);
                        if (index !== -1) allBookmarksFlat[index] = updatedBookmark;
                        allBookmarksByTag = groupBookmarksByTag(allBookmarksFlat);

                        reRenderUI();
                    } catch (error) {
                        if (error instanceof LinkdingConnectionError) {
                            showStatusBanner('Unable to connect to Linkding.');
                        } else {
                            showStatusBanner(`An error occurred: ${error.message}`)
                        }
                    }
                });

                tagItem.appendChild(removeBtn);
                tagsDiv.appendChild(tagItem);
            });
        }

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'bookmark-actions';

        const editBtn = document.createElement('button');
        editBtn.title = 'Edit';
        editBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
        editBtn.addEventListener('click', () => {
            // Use the shared side-panel form rather than inline edit.
            li.draggable = false;
            openEditInSidePanel(bookmark);
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.title = 'Delete';
        deleteBtn.className = 'delete-btn';
        deleteBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
        deleteBtn.addEventListener('click', async () => {
            if (confirm(`Are you sure you want to delete "${title}"?`)) {
                try {
                    await linkding.deleteBookmark(bookmark.id);
                    broadcastBookmarkChange('deleted', { bookmarkIds: [bookmark.id] });
                    allBookmarksFlat = allBookmarksFlat.filter(b => b.id !== bookmark.id);
                    allBookmarksByTag = groupBookmarksByTag(allBookmarksFlat);
                    allTags = [...new Set(allBookmarksFlat.flatMap(b => b.tag_names))].sort();
                    reRenderUI();
                } catch (error) {
                    if (error instanceof LinkdingConnectionError) {
                        showStatusBanner('Unable to connect to Linkding.');
                    } else {
                        showStatusBanner(`An error occurred: ${error.message}`)
                    }
                }
            }
        });

        li.addEventListener('dragstart', (e) => {
            if (!li.draggable) {
                e.preventDefault();
                return;
            }
            // We need to pass both the bookmark ID and its original tag
            const payload = { id: bookmark.id, sourceTag: sourceTag };
            e.dataTransfer.setData('application/json', JSON.stringify(payload));
            e.dataTransfer.effectAllowed = 'move';
            // Use a timeout to allow the browser to render the drag image before we apply the class
            setTimeout(() => li.classList.add('dragging'), 0);
        });

        li.addEventListener('dragend', () => li.classList.remove('dragging'));

        actionsDiv.appendChild(editBtn);
        actionsDiv.appendChild(deleteBtn);
        li.appendChild(infoDiv);
        li.appendChild(tagsDiv);
        li.appendChild(actionsDiv);

        return li;
    }

    function reRenderUI() {
        // Preserve the open/closed state of folders before re-rendering
        const openFolderTags = new Set();
        document.querySelectorAll('#folder-pane .folder-item.open').forEach(folder => {
            if (folder.dataset.tag) {
                openFolderTags.add(folder.dataset.tag);
            }
        });

        // 1. Render the folder structure first.
        renderFolders();

        // 2. Now that the folders are in the DOM, restore their open state.
        if (openFolderTags.size > 0) {
            openFolderTags.forEach(tag => {
                const parts = tag.split('.');
                let currentPath = '';
                parts.forEach(part => {
                    currentPath = currentPath ? `${currentPath}.${part}` : part;
                    const folderToOpen = document.querySelector(`.folder-item[data-tag="${currentPath}"]`);
                    if (folderToOpen) {
                        folderToOpen.classList.add('open');
                    }
                });
            });
        }

        // 3. Finally, render the bookmarks for the active folder.
        // If the current tag was removed or renamed, it might not exist anymore.
        if (!allBookmarksByTag[currentTag]) {
            currentTag = Object.keys(allBookmarksByTag)[0] || null;
        }
        renderBookmarksForTag(currentTag);
    }

    function renderBookmarksForTag(tag, bookmarksToRender) {
        // If searching, bookmarksToRender is provided. Otherwise, use the global map.
        const bookmarks = bookmarksToRender || allBookmarksByTag[tag] || [];

        // Only update active state if not searching
        if (!bookmarksToRender) {
            currentTag = tag;
            document.querySelectorAll('.folder-item').forEach(item => {
                item.classList.toggle('active', item.dataset.tag === tag);
            });
        }

        bookmarks.sort((a, b) => {
            const titleA = (a.title || a.website_title || '').toLowerCase();
            const titleB = (b.title || b.website_title || '').toLowerCase();
            return titleA.localeCompare(titleB);
        });

        bookmarksList.innerHTML = '';
        bookmarksList.classList.remove('hidden');
        loadingMessage.classList.add('hidden');

        if (!tag) {
            bookmarksList.innerHTML = '<p class="empty-state">Select a folder to view bookmarks.</p>';
            return;
        }
        if (bookmarks.length === 0 && !bookmarksToRender) { // Don't show for empty search results
            bookmarksList.innerHTML = '<p class="empty-state">No bookmarks found.</p>';
            return;
        }

        const ul = document.createElement('ul');
        bookmarks.forEach(bookmark => ul.appendChild(createBookmarkElement(bookmark, tag)));
        bookmarksList.appendChild(ul);
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
                // If it's the last part, this node represents a real tag
                if (index === parts.length - 1) {
                    currentNode[part].__isTag = true;
                    currentNode[part].__fullName = tag;
                }
                currentNode = currentNode[part].__children;
            });
        });
        return tree;
    }

    function renderFolderTree(node, container, path = []) {
        const sortedKeys = Object.keys(node).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

        for (const key of sortedKeys) {
            const currentPath = [...path, key];
            const tagNode = node[key];
            const folderItem = document.createElement('div');
            folderItem.className = 'folder-item';

            // Every folder is a potential drop target. The tag is its full path.
            const potentialTagName = currentPath.join('.');
            folderItem.dataset.tag = potentialTagName;
            folderItem.addEventListener('dragover', (e) => { e.preventDefault(); folderItem.classList.add('drag-over'); });
            folderItem.addEventListener('dragleave', () => { folderItem.classList.remove('drag-over'); });
            folderItem.addEventListener('drop', handleDrop);

            const folderLabel = document.createElement('div');
            folderLabel.className = 'folder-label';

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

            folderLabel.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();

                const isUntagged = potentialTagName === '[Untagged]';

                contextMenu.innerHTML = `
                    <div class="context-menu-item" data-action="add">New ${isUntagged ? 'Top-level folder' : 'Sub-folder'}</div>
                    <div class="context-menu-item ${isUntagged ? 'disabled' : ''}" data-action="rename">Rename</div>
                    <div class="context-menu-item ${isUntagged ? 'disabled' : ''}" data-action="remove">Remove</div>
                `;

                contextMenu.style.top = `${e.pageY}px`;
                contextMenu.style.left = `${e.pageX}px`;
                contextMenu.classList.remove('hidden');

                contextMenu.querySelector('[data-action="add"]').addEventListener('click', () => handleAddFolder(potentialTagName));
                if (!isUntagged) {
                    contextMenu.querySelector('[data-action="rename"]').addEventListener('click', () => handleRenameFolder(potentialTagName, key));
                    contextMenu.querySelector('[data-action="remove"]').addEventListener('click', () => handleRemoveFolder(potentialTagName));
                }
            });

            folderItem.appendChild(folderLabel);

            let childrenContainer;
            if (hasChildren) {
                childrenContainer = document.createElement('div');
                childrenContainer.className = 'folder-children';
                renderFolderTree(tagNode.__children, childrenContainer, currentPath);
                folderItem.appendChild(childrenContainer);
            }

            // A single, unified click listener on the entire label.
            folderLabel.addEventListener('click', () => {
                // Action 1: Select the folder to display its bookmarks, but only if it's a real tag.
                if (tagNode.__isTag) {
                    renderBookmarksForTag(tagNode.__fullName);
                }

                // Action 2: Toggle expansion if it has children.
                if (hasChildren) {
                    folderItem.classList.toggle('open');
                }
            });

            // If a folder is not a real tag (just a parent), make it look less interactive.
            if (!tagNode.__isTag) {
                folderName.style.opacity = '0.8';
            }
            container.appendChild(folderItem);
        }
    }
    function renderFolders() {
        folderListContainer.innerHTML = '';
        tagTree = buildTagTree(Object.keys(allBookmarksByTag));
        renderFolderTree(tagTree, folderListContainer);
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
            if (currentTag) renderBookmarksForTag(currentTag);
            return;
        }

        // Correctly filter the flat list of all bookmarks
        const filteredBookmarks = allBookmarksFlat.filter(b =>
            (b.title?.toLowerCase().includes(lowerCaseSearchTerm)) ||
            (b.website_title?.toLowerCase().includes(lowerCaseSearchTerm)) ||
            (b.description?.toLowerCase().includes(lowerCaseSearchTerm)) ||
            (b.url?.toLowerCase().includes(lowerCaseSearchTerm))
        );

        document.querySelectorAll('.folder-item.active').forEach(item => item.classList.remove('active'));
        renderBookmarksForTag('Search Results', filteredBookmarks);
    }

    async function loadData(forceRefresh = false) {
        // Preserve the open/closed state of folders before re-rendering
        const openFolderTags = new Set();
        document.querySelectorAll('#folder-pane .folder-item.open').forEach(folder => {
            if (folder.dataset.tag) {
                openFolderTags.add(folder.dataset.tag);
            }
        });

        statusBanner.classList.add('hidden');
        errorMessage.classList.add('hidden');
        // Only show the main loading message on the initial load, not on refreshes.
        if (!forceRefresh) {
            loadingMessage.classList.remove('hidden');
            bookmarksList.innerHTML = '';
        }

        try {
            linkding = linkding || await createLinkding();
            const result = await linkding.getBookmarksWithStatus({ forceRefresh });
            allBookmarksFlat = result.data;
            allBookmarksByTag = groupBookmarksByTag(allBookmarksFlat);
            allTags = [...new Set(allBookmarksFlat.flatMap(b => b.tag_names))].sort();

            // 1. Render the folder structure first.
            renderFolders();

            // 2. Now that the folders are in the DOM, restore their open state.
            if (openFolderTags.size > 0) {
                openFolderTags.forEach(tag => {
                    const parts = tag.split('.');
                    let currentPath = '';
                    parts.forEach(part => {
                        currentPath = currentPath ? `${currentPath}.${part}` : part;
                        const folderToOpen = document.querySelector(`.folder-item[data-tag="${currentPath}"]`);
                        if (folderToOpen) {
                            folderToOpen.classList.add('open');
                        }
                    });
                });
            }

            // 3. Finally, render the bookmarks for the active folder.
            const tagToRender = currentTag && allBookmarksByTag[currentTag] ? currentTag : Object.keys(allBookmarksByTag)[0];
            if (tagToRender) {
                renderBookmarksForTag(tagToRender);
            }

            if (result.stale && result.error instanceof LinkdingConnectionError) {
                showStatusBanner('Unable to connect to Linkding. Showing cached bookmarks.');
            }
        } catch (error) {
            console.error('Error fetching bookmarks:', error);
            if (error instanceof LinkdingConnectionError) {
                showStatusBanner('Unable to connect to Linkding.');
            } else {
                const isConfigurationError =
                    error.message.includes('Linkding URL') ||
                    error.message.includes('API token') ||
                    error.message.includes('API Token');
                showError(
                    `Failed to load bookmarks. Error: ${error.message}`,
                    isConfigurationError
                );
            }
        } finally {
            // On initial load, this hides the loading message. On refresh, this does nothing.
            loadingMessage.classList.add('hidden');
        }
    }

    async function init() {
        createContextMenu();
        searchBox.addEventListener('input', (e) => filterAndRender(e.target.value));
        refreshBtn.addEventListener('click', () => loadData(true));
        await loadData();
    }

    init();
});
