/**
 * High-level Linkding facade.
 *
 * Consumers should normally use this component instead of knowing
 * about the API client or cache implementation.
 */

class Linkding {
    constructor(api, bookmarkCache = new BookmarkCache()) {
        this.api = api;
        this.bookmarkCache = bookmarkCache;
    }

    async getBookmarks({ forceRefresh = false } = {}) {
        if (forceRefresh) {
            return this.bookmarkCache.refresh(this.api);
        }

        return this.bookmarkCache.getAll(this.api);
    }

    async getBookmarksWithStatus({forceRefresh = false} = {}) {
        const cached = await this.bookmarkCache.get();

        if (!forceRefresh && this.bookmarkCache.isFresh(cached)) {
            return {
                data: cached.data,
                stale: false,
            };
        }

        try {
            return {
                data: await this.bookmarkCache.refresh(this.api),
                stale: false,
            };
        } catch (error) {
            if (!(error instanceof LinkdingConnectionError)) {
                throw error;
            }

            if (cached) {
                return {
                    data: cached.data,
                    stale: true,
                    error,
                };
            }

            throw error;
        }
    }

    getBookmark(id) {
        return this.api.getBookmark(id);
    }

    checkBookmark(url) {
        return this.api.checkBookmark(url);
    }

    async createBookmark(data) {
        const bookmark = await this.api.createBookmark(data);
        await this.bookmarkCache.invalidate();
        return bookmark;
    }

    async updateBookmark(id, data) {
        const bookmark = await this.api.updateBookmark(id, data);
        await this.bookmarkCache.invalidate();
        return bookmark;
    }

    async deleteBookmark(id) {
        const result = await this.api.deleteBookmark(id);
        await this.bookmarkCache.invalidate();
        return result;
    }

    getTags(params = {}) {
        return this.api.getTags(params);
    }

    getBookmarkAssets(bookmarkId, params = {}) {
        return this.api.getBookmarkAssets(bookmarkId, params);
    }

    /**
     * Uploads a file (e.g. a screenshot) as an asset attached to an
     * existing bookmark. This does not touch the bookmark cache, since
     * assets aren't part of the cached bookmark list payload.
     */
    uploadBookmarkAsset(bookmarkId, file, filename) {
        return this.api.uploadBookmarkAsset(bookmarkId, file, filename);
    }

    deleteBookmarkAsset(bookmarkId, assetId) {
        return this.api.deleteBookmarkAsset(bookmarkId, assetId);
    }
}

async function createLinkding() {
    const api = await createLinkdingApi();

    return new Linkding(api);
}
