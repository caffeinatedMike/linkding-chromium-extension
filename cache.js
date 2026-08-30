/**
 * Persistent cache backed by chrome.storage.local.
 *
 * Entries are considered fresh only while their age is strictly less
 * than the configured TTL. The timestamp records the time at which
 * the data was successfully pulled.
 */

class StorageCache {
    constructor({ key, ttl = 15 * 60 * 1000 }) {
        this.key = key;
        this.ttl = ttl;
        this._fetchPromise = null;
    }

    async get() {
        const result = await chrome.storage.local.get(this.key);
        return result[this.key] ?? null;
    }

    async set(data) {
        const entry = {data, pulledAt: Date.now()};
        await chrome.storage.local.set({ [this.key] : entry });
        return entry;
    }

    async clear() {
        await chrome.storage.local.remove(this.key);
    }

    isFresh(entry) {
        if (!entry || typeof entry.pulledAt !== 'number') {
            return false;
        }

        return Date.now() - entry.pulledAt < this.ttl;
    }

    isStale(entry) {
        return !this.isFresh(entry);
    }

    async getFresh() {
        const entry = await this.get();

        return this.isFresh(entry)
            ? entry.data
            : null;
    }

    async getOrFetch(fetcher) {
        const entry = await this.get();

        if (this.isFresh(entry)) {
            return entry.data;
        }

        return this._fetchAndStore(fetcher);
    }

    async refresh(fetcher) {
        return this._fetchAndStore(fetcher);
    }

    async _fetchAndStore(fetcher) {
        // Deduplicate simultaneous refreshes from popup, side panel,
        // manager, or other extension contexts that share this cache.
        if (!this._fetchPromise) {
            this._fetchPromise = (async () => {
                try {
                    const data = await fetcher();

                    // Only successful pulls update the timestamp.
                    await this.set(data);

                    return data;
                } finally {
                    this._fetchPromise = null;
                }
            })();
        }

        return this._fetchPromise;
    }
}

class BookmarkCache extends StorageCache {
    constructor() {
        super({
            key: 'linkdingBookmarks',
            ttl: 15 * 60 * 1000,
        });
    }

    getAll(api) {
        return this.getOrFetch(
            () => api.getAllBookmarks()
        );
    }

    refresh(api) {
        return super.refresh(
            () => api.getAllBookmarks()
        );
    }

    invalidate() {
        return this.clear();
    }
}
