importScripts(
    'api.js',
    'cache.js',
    'linkding.js',
);

function setActionForMode(mode) {
    if (mode === 'sidebar') {
        // Open side panel on click, disable popup
        chrome.action.setPopup({ popup: '' }); // An empty string disables the popup
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
            .catch((error) => console.error(error));
    } else { // default to 'popup'
        // Open popup on click, disable side panel direct open
        chrome.action.setPopup({ popup: 'popup.html' });
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
            .catch((error) => console.error(error));
    }
}

// Set the initial action on install/startup
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.sync.get('displayMode', (data) => {
        setActionForMode(data.displayMode || 'popup');
    });

    // Add a context menu item to always have access to the manager
    chrome.contextMenus.create({
        id: 'open-manager',
        title: 'Open Bookmark Manager',
        contexts: ['action']
    });

    // Add a context menu item for bookmarking links
    chrome.contextMenus.create({
        id: 'bookmark-link',
        title: 'Bookmark this link in Linkding',
        contexts: ['link']
    });

    // Add a context menu item for bookmarking current page
    chrome.contextMenus.create({
        id: 'bookmark-page',
        title: 'Bookmark this page in Linkding',
        contexts: ['page']
    });

    // TODO: bookmark-clipboard
});

// Listen for changes in storage to update the action on the fly
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' && changes.displayMode) {
        setActionForMode(changes.displayMode.newValue);
    }
});

// Listener for the context menu
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'open-manager') {
        chrome.tabs.create({ url: 'manager.html' });
        return;
    }

    let bookmark;
    switch (info.menuItemId){
        case 'bookmark-link':
            if (!info.linkUrl) return;
            bookmark = { url: info.linkUrl, title: info.selectionText };
            break;
        case 'bookmark-page':
            if (!tab?.url) return;
            bookmark = { url: tab.url, title: tab.title };
            break;
        case 'bookmark-clipboard':
            // TODO
            return;
        default:
            return;
    }

    try {
        const linkding = await createLinkding();
        const createdBookmark = await linkding.createBookmark(bookmark);
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/favicon128.png',
            title: 'Linkding Bookmark Saved',
            message: `Successfully bookmarked: ${bookmark.url}`,
        });
        // Broadcast message to any subscribed frontend component
        // that the bookmarks cache has been invalidated and the
        // UI needs to be updated immediately
        chrome.runtime.sendMessage({
            type: 'linkding-bookmarks-changed',
            reason: 'created',
            bookmarks: [createdBookmark],
        }).catch(() => {});
    } catch (error) {
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/favicon128.png',
            title: 'Linkding Bookmark Failed',
            message: `Could not save bookmark. Error: ${error.message}`,
        });
        console.error('Failed to bookmark link:', error);
    }
});
