/**
 * Shared add/edit bookmark form.
 *
 * Renders a modal dialog for adding a bookmark for a given URL. Before
 * showing the form, it checks the Linkding instance for an existing
 * bookmark at that URL (via LinkdingApi#checkBookmark) and, if found,
 * prefills the form from it and switches into "edit" mode so saving
 * updates the existing bookmark instead of creating a duplicate.
 *
 * Used from:
 *   - The "+" button in the side panel (current tab).
 *   - The right-click context menu on links/pages, which opens the
 *     side panel and passes the pending bookmark request to it.
 */
const BookmarkForm = (() => {
    let activeForm = null;
    function buildDialog() {
        const overlay = document.createElement('div');
        overlay.className = 'bookmark-form-overlay';
        overlay.innerHTML = `
            <div class="bookmark-form-dialog" role="dialog" aria-modal="true">
                <div class="bookmark-form-header">
                    <h2 id="bf-heading">Add Bookmark</h2>
                    <button type="button" class="bookmark-form-close" title="Close" aria-label="Close">&times;</button>
                </div>
                <div id="bf-hint" class="bookmark-form-hint hidden"></div>
                <form class="bookmark-form" novalidate>
                    <div class="bookmark-form-field">
                        <label for="bf-url">URL</label>
                        <div class="has-icon-right">
                            <input type="text" id="bf-url" name="url" required autocomplete="off">
                            <i id="bf-url-spinner" class="bf-spinner hidden"></i>
                        </div>
                    </div>
                    <div class="bookmark-form-field">
                        <label for="bf-title">Title</label>
                        <input type="text" id="bf-title" name="title" autocomplete="off">
                    </div>
                    <div class="bookmark-form-field">
                        <label for="bf-description">Description</label>
                        <textarea id="bf-description" name="description" rows="3"></textarea>
                    </div>
                    <div class="bookmark-form-field tag-input-container">
                        <label for="bf-tags">Tags (comma-separated)</label>
                        <input type="text" id="bf-tags" name="tags" autocomplete="off">
                    </div>
                    <div class="bookmark-form-field bookmark-form-checkbox">
                        <label>
                            <input type="checkbox" id="bf-unread" name="unread">
                            <span>Mark as unread</span>
                        </label>
                    </div>
                    <div class="bookmark-form-field bookmark-form-checkbox">
                        <label>
                            <input type="checkbox" id="bf-screenshot" name="screenshot">
                            <span title="Capture a full-page screenshot and attach it as an asset to the bookmark.">Save screenshot</span>
                        </label>
                    </div>
                    <div id="bf-error" class="bookmark-form-error hidden"></div>
                    <div class="bookmark-form-actions">
                        <button type="button" class="bf-cancel-btn">Cancel</button>
                        <button type="submit" class="bf-save-btn">Save</button>
                    </div>
                </form>
            </div>
        `;
        return overlay;
    }

    function attachTagAutocomplete(input, container, allTags) {
        if (!allTags || allTags.length === 0) return;

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

            const filtered = allTags.filter(tag =>
                tag.toLowerCase().startsWith(currentTerm) && !terms.includes(tag)
            );
            suggestionsDiv.innerHTML = '';

            if (filtered.length > 0) {
                suggestionsDiv.classList.remove('hidden');
                filtered.forEach(tag => {
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

        document.addEventListener('click', (e) => {
            if (!container.contains(e.target)) {
                suggestionsDiv.classList.add('hidden');
            }
        });
    }

    function buildScreenshotApprovalDialog(dataUrl) {
        const overlay = document.createElement('div');
        overlay.className = 'bookmark-form-overlay screenshot-approval-overlay';
        overlay.innerHTML = `
            <div class="bookmark-form-dialog screenshot-approval-dialog" role="dialog" aria-modal="true" aria-labelledby="screenshot-approval-heading">
                <div class="bookmark-form-header">
                    <h2 id="screenshot-approval-heading">Save Screenshot?</h2>
                    <button type="button" class="bookmark-form-close screenshot-cancel-btn" title="Don't save screenshot" aria-label="Don't save screenshot">&times;</button>
                </div>
                <div class="screenshot-approval-content">
                    <p>Review the full-page screenshot before attaching it to the bookmark.</p>
                    <div class="screenshot-preview-container">
                        <img class="screenshot-preview" src="${dataUrl}" alt="Full-page screenshot preview">
                    </div>
                </div>
                <div class="bookmark-form-actions">
                    <button type="button" class="bf-cancel-btn screenshot-cancel-btn">Don't Save</button>
                    <button type="button" class="bf-save-btn screenshot-approve-btn">Save Screenshot</button>
                </div>
            </div>
        `;
        return overlay;
    }

    /**
     * Capture a screenshot from a tab through the background service worker.
     */
    function captureScreenshot(tabId) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { type: 'capture-full-page-screenshot', tabId },
                (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }

                    if (!response?.success) {
                        reject(new Error(response?.error || 'Screenshot capture failed.'));
                        return;
                    }

                    resolve(response.dataUrl);
                }
            );
        });
    }

    /**
     * Convert a data URL containing the PNG screenshot into a File.
     */
    function dataUrlToFile(dataUrl, filename = 'screenshot.png') {
        const [header, base64] = dataUrl.split(',');

        if (!header || !base64) {
            throw new Error('Invalid screenshot data.');
        }

        const mimeMatch = header.match(/data:([^;]+);base64/);
        const mimeType = mimeMatch?.[1] || 'image/png';
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);

        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }

        return new File([bytes], filename, { type: mimeType });
    }

    /**
     * Show the screenshot approval dialog.
     *
     * Resolves true when approved and false when rejected.
     */
    function requestScreenshotApproval(dataUrl, container = document.body) {
        return new Promise((resolve) => {
            const overlay = buildScreenshotApprovalDialog(dataUrl);
            container.appendChild(overlay);

            let resolved = false;

            function finish(approved) {
                if (resolved) return;
                resolved = true;

                overlay.remove();
                resolve(approved);
            }

            overlay.querySelectorAll('.screenshot-cancel-btn').forEach(button => {
                button.addEventListener('click', () => {
                    finish(false);
                });
            });

            overlay.querySelector('.screenshot-approve-btn').addEventListener('click', () => {
                finish(true);
            });

            overlay.addEventListener('click', (event) => {
                if (event.target === overlay) {
                    finish(false);
                }
            });

            const escListener = (event) => {
                if (event.key !== 'Escape') return;
                document.removeEventListener('keydown', escListener);
                finish(false);
            };

            document.addEventListener('keydown', escListener);
        });
    }


    /**
     * Opens the form.
     *
     * @param {Object} opts
     * @param {HTMLElement} [opts.container=document.body] - Where to mount the modal.
     * @param {string} opts.url - URL to prefill/check.
     * @param {string} [opts.title] - Title to prefill for new bookmarks.
     * @param {Object} opts.linkding - A Linkding facade instance (see linkding.js).
     * @param {string[]} [opts.allTags] - Known tag names, for autocomplete.
     * @param {function(Object, 'created'|'updated')} [opts.onSaved] - Called after a successful save.
     * @param {function()} [opts.onCancel] - Called when the user closes/cancels without saving.
     * @returns {{close: function()}}
     */
    function open(opts) {
        const {
            container = document.body,
            bookmark = null,
            url = '',
            title = '',
            linkding,
            allTags = [],
            tabId = null,
            onSaved = () => {},
            onCancel = () => {},
        } = opts;

        // Only one add/edit form may be open at a time.
        if (activeForm) {
            activeForm.close();
        }

        const overlay = buildDialog();
        container.appendChild(overlay);

        const heading = overlay.querySelector('#bf-heading');
        const hint = overlay.querySelector('#bf-hint');
        const form = overlay.querySelector('.bookmark-form');
        const urlInput = overlay.querySelector('#bf-url');
        const urlSpinner = overlay.querySelector('#bf-url-spinner');
        const titleInput = overlay.querySelector('#bf-title');
        const descInput = overlay.querySelector('#bf-description');
        const tagsInput = overlay.querySelector('#bf-tags');
        const unreadInput = overlay.querySelector('#bf-unread');
        const screenshotInput = overlay.querySelector('#bf-screenshot');
        const errorBox = overlay.querySelector('#bf-error');
        const saveBtn = overlay.querySelector('.bf-save-btn');
        const closeBtn = overlay.querySelector('.bookmark-form-close');
        const cancelBtn = overlay.querySelector('.bf-cancel-btn');

        let existingBookmark = null;
        let closed = false;
        let formInstance = null;

        function close() {
            if (closed) return;
            closed = true;

            overlay.remove();

            if (activeForm === formInstance) {
                activeForm = null;
            }
        }

        function handleCancel() {
            close();
            onCancel();
        }

        closeBtn.addEventListener('click', handleCancel);
        cancelBtn.addEventListener('click', handleCancel);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) handleCancel();
        });
        document.addEventListener('keydown', function escListener(e) {
            if (e.key === 'Escape' && !closed) {
                document.removeEventListener('keydown', escListener);
                handleCancel();
            }
        });

        function showError(message) {
            errorBox.textContent = message;
            errorBox.classList.remove('hidden');
        }

        function clearError() {
            errorBox.classList.add('hidden');
            errorBox.textContent = '';
        }

        function showHint(message, isWarning = true) {
            hint.textContent = message;
            hint.classList.remove('hidden');
            hint.classList.toggle('text-warning', isWarning);
            hint.classList.toggle('text-success', !isWarning);
        }

        function applyExistingBookmark(bookmark) {
            existingBookmark = bookmark;
            heading.textContent = 'Edit Bookmark';
            showHint('This URL is already bookmarked. The form has been prefilled from the ' +
                'existing bookmark, and saving will update it instead of creating a duplicate.');
            titleInput.value = bookmark.title || bookmark.website_title || '';
            descInput.value = bookmark.description || '';
            tagsInput.value = (bookmark.tag_names || []).join(', ');
            unreadInput.checked = !!bookmark.unread;
            /*
             * Screenshot is an action for this save operation, not a
             * persisted bookmark property. Therefore it intentionally
             * starts unchecked when editing an existing bookmark.
             */
            screenshotInput.checked = false;
        }

        function applyNewBookmarkMetadata(metadata, autoTags) {
            if (metadata) {
                if (!titleInput.value) titleInput.value = metadata.title || '';
                if (!descInput.value) descInput.value = metadata.description || '';
            }
            if (autoTags && autoTags.length) {
                showHint(`Suggested tags: ${autoTags.join(', ')}`, false);
            }
        }

        async function checkExisting() {
            if (!url || !linkding) return;

            urlSpinner.classList.remove('hidden');
            saveBtn.disabled = true;
            try {
                const result = await linkding.checkBookmark(url);
                if (closed) return;
                if (result?.bookmark) {
                    applyExistingBookmark(result.bookmark);
                } else {
                    applyNewBookmarkMetadata(result?.metadata, result?.auto_tags);
                }
            } catch (error) {
                // Older Linkding instances, or a misconfigured connection, may not
                // support the check endpoint. Fall back to a plain "add" form.
                console.warn('Could not check for an existing bookmark:', error.message);
            } finally {
                urlSpinner.classList.add('hidden');
                saveBtn.disabled = false;
            }
        }

        async function saveScreenshot(savedBookmark, screenshotDataUrl) {
            const screenshotFile = dataUrlToFile(screenshotDataUrl, 'screenshot.png');
            return linkding.uploadBookmarkAsset(savedBookmark.id, screenshotFile, 'screenshot.png');
        }

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            clearError();

            const data = {
                url: urlInput.value.trim(),
                title: titleInput.value,
                description: descInput.value,
                tag_names: tagsInput.value.split(',').map(t => t.trim()).filter(Boolean),
                unread: unreadInput.checked,
            };

            if (!data.url) {
                showError('A URL is required.');
                return;
            }

            if (screenshotInput.checked && !tabId) {
                showError('A screenshot cannot be captured because the source tab is unavailable.');
                return;
            }

            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving\u2026';

            try {
                const mode = existingBookmark ? 'updated' : 'created';
                /*
                 * Save the bookmark first. The screenshot is an
                 * optional asset attached to the saved bookmark.
                 */
                const savedBookmark = existingBookmark
                    ? await linkding.updateBookmark(existingBookmark.id, { ...existingBookmark, ...data })
                    : await linkding.createBookmark(data);

                chrome.runtime.sendMessage({
                    type: 'linkding-bookmarks-changed',
                    reason: mode,
                    bookmarks: [savedBookmark],
                }).catch(() => {});

                close();
                onSaved(savedBookmark, mode);

                if (!screenshotInput.checked) return;

                // Capture the screenshot after the bookmark has been saved.
                let screenshotDataUrl;

                try {
                    screenshotDataUrl = await captureScreenshot(tabId);
                } catch (error) {
                    showScreenshotError(`The bookmark was saved, but the screenshot could not be captured: ${error.message}`);
                    return;
                }

                /*
                 * Give the user an opportunity to inspect the
                 * screenshot before uploading it.
                 */
                const approved = await requestScreenshotApproval(screenshotDataUrl, container);

                if (!approved) {
                    showScreenshotStatus('Bookmark saved. Screenshot was not attached.');
                    return;
                }

                try {
                    await saveScreenshot(savedBookmark, screenshotDataUrl);
                    showScreenshotStatus('Bookmark saved and screenshot attached.');
                } catch (error) {
                    showScreenshotError(`The bookmark was saved, but the screenshot could not be uploaded: ${error.message}`);
                }
            } catch (error) {
                showError(`Could not save bookmark: ${error.message}`);
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save';
            }
        });

        attachTagAutocomplete(tagsInput, overlay.querySelector('.tag-input-container'), allTags);

        urlInput.value = bookmark?.url || url;
        titleInput.value = bookmark?.title || bookmark?.website_title || title || '';

        if (bookmark) {
            applyExistingBookmark(bookmark);
        } else {
            checkExisting();
        }

        titleInput.focus();

        formInstance = { close };
        activeForm = formInstance;

        return formInstance;
    }

    /*
     * These two helpers deliberately use the existing global status
     * mechanism where available. They also fall back to alert() so
     * bookmark-form.js remains usable by manager.html.
     */
    function showScreenshotStatus(message) {
        if (typeof window.showAddStatus === 'function') {
            window.showAddStatus(message);
            return;
        }

        const status = document.getElementById('add-status');
        const statusMessage = document.getElementById('add-status-message');

        if (status) {
            status.classList.remove('error');
            statusMessage.textContent = message;
            status.classList.remove('hidden');
            setTimeout(() => { status.classList.add('hidden'); }, 4000);
            return;
        }

        console.info(message);
    }

    function showScreenshotError(message) {
        if (typeof window.showAddStatus === 'function') {
            window.showAddStatus(message, true);
            return;
        }

        const status = document.getElementById('add-status');
        const statusMessage = document.getElementById('add-status-message');
        const statusDismiss = document.getElementById('add-status-dismiss');

        if (status) {
            statusDismiss.addEventListener('click', () => {
                status.classList.add('hidden');
            });

            status.classList.add('error');
            statusMessage.textContent = message;
            status.classList.remove('hidden');
            return;
        }

        console.error(message);
    }

    return { open };
})();