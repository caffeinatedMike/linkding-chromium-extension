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
            url = '',
            title = '',
            linkding,
            allTags = [],
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
                if (result && result.bookmark) {
                    applyExistingBookmark(result.bookmark);
                } else {
                    applyNewBookmarkMetadata(result && result.metadata, result && result.auto_tags);
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

            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving\u2026';

            try {
                const mode = existingBookmark ? 'updated' : 'created';
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
            } catch (error) {
                showError(`Could not save bookmark: ${error.message}`);
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save';
            }
        });

        attachTagAutocomplete(tagsInput, overlay.querySelector('.tag-input-container'), allTags);

        urlInput.value = url;
        titleInput.value = title || '';
        titleInput.focus();
        checkExisting();

        formInstance = { close };
        activeForm = formInstance;

        return formInstance;
    }

    return { open };
})();