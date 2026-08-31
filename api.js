/**
 * Centralized Linkding HTTP/API client.
 *
 * This component is UI-agnostic and can be used from extension pages
 * and the Manifest V3 background service worker.
 */

class LinkdingApiError extends Error {
    constructor(status, statusText, body, url) {
        super(
            `Linkding API request failed: ${status} ${statusText}` +
            (body ? `: ${body}` : '')
        );

        this.name = 'LinkdingApiError';
        this.status = status;
        this.statusText = statusText;
        this.body = body;
        this.url = url;
    }
}

class LinkdingApi {
    constructor({ baseUrl, token }) {
        if (!baseUrl) {
            throw new Error('Linkding URL is required.');
        }

        if (!token) {
            throw new Error('Linkding API token is required.');
        }

        this.baseUrl = baseUrl.trim().replace(/\/+$/, '');
        this.token = token;
    }

    buildUrl(endpoint, params = {}) {
        const url = new URL(
            endpoint.startsWith('http')
                ? endpoint
                : `${this.baseUrl}${endpoint}`
        );

        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) {
                url.searchParams.set(key, value);
            }
        }

        return url.toString();
    }

    async request(endpoint, options = {}) {
        const url = endpoint.startsWith('http')
            ? endpoint
            : `${this.baseUrl}${endpoint}`;

        const headers = {
            Authorization: `Token ${this.token}`,
            ...options.headers,
        };

        if (options.body !== undefined && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }

        const response = await fetch(url, {
            ...options,
            headers,
        });

        if (!response.ok) {
            const body = await response.text();

            throw new LinkdingApiError(
                response.status,
                response.statusText,
                body,
                url,
            );
        }

        if (response.status === 204) {
            return null;
        }

        return response.json();
    }

    get(endpoint, options = {}) {
        return this.request(endpoint, {
            ...options,
            method: 'GET',
        });
    }

    post(endpoint, data, options = {}) {
        return this.request(endpoint, {
            ...options,
            method: 'POST',
            body: JSON.stringify(data),
        });
    }

    put(endpoint, data, options = {}) {
        return this.request(endpoint, {
            ...options,
            method: 'PUT',
            body: JSON.stringify(data),
        });
    }

    patch(endpoint, data, options = {}) {
        return this.request(endpoint, {
            ...options,
            method: 'PATCH',
            body: JSON.stringify(data),
        });
    }

    delete(endpoint, options = {}) {
        return this.request(endpoint, {
            ...options,
            method: 'DELETE',
        });
    }

    async getBookmarks(params = {}) {
        const query = new URLSearchParams(params).toString();

        return this.get(
            `/api/bookmarks/${query ? `?${query}` : ''}`
        );
    }

    async getAllBookmarks() {
        const bookmarks = [];
        let nextUrl = this.buildUrl('/api/bookmarks/', {
            limit: 100,
        });

        while (nextUrl) {
            const data = await this.get(nextUrl);

            bookmarks.push(...(data.results || []));
            nextUrl = data.next;
        }

        return bookmarks;
    }

    getBookmark(id) {
        return this.get(`/api/bookmarks/${id}/`);
    }

    createBookmark(data) {
        return this.post('/api/bookmarks/', data);
    }

    updateBookmark(id, data) {
        return this.put(`/api/bookmarks/${id}/`, data);
    }

    deleteBookmark(id) {
        return this.delete(`/api/bookmarks/${id}/`);
    }

    getTags(params = {}) {
        const query = new URLSearchParams(params).toString();

        return this.get(
            `/api/tags/${query ? `?${query}` : ''}`
        );
    }

    getBookmarkAssets(bookmarkId, params = {}) {
        const query = new URLSearchParams(params).toString();

        return this.get(
            `/api/bookmarks/${bookmarkId}/assets/${query ? `?${query}` : ''}`
        );
    }

    getBookmarkAsset(bookmarkId, assetId) {
        return this.get(`/api/bookmarks/${bookmarkId}/assets/${assetId}/`);
    }

    uploadBookmarkAsset(bookmarkId, file, filename) {
        const formData = new FormData();
        const name = filename || file.name;

        if (!name) {
            throw new Error(
                'A filename is required to upload a bookmark asset.'
            );
        }

        formData.append('file', file, name);

        return this.request(`/api/bookmarks/${bookmarkId}/assets/upload/`, {
            method: 'POST',
            body: formData,
        });
    }

    deleteBookmarkAsset(bookmarkId, assetId) {
        return this.delete(`/api/bookmarks/${bookmarkId}/assets/${assetId}/`);
    }
}

async function createLinkdingApi() {
    const { linkdingUrl, apiToken } =
        await chrome.storage.sync.get([
            'linkdingUrl',
            'apiToken',
        ]);

    if (!linkdingUrl || !apiToken) {
        throw new Error(
            'Linkding URL or API Token is not configured.'
        );
    }

    return new LinkdingApi({
        baseUrl: linkdingUrl,
        token: apiToken,
    });
}
