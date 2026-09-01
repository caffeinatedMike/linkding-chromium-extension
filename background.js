async function configureSidePanel() {
    await chrome.sidePanel.setPanelBehavior({
        openPanelOnActionClick: true,
    });
}

// Configure the side panel when the extension is installed.
chrome.runtime.onInstalled.addListener(() => {
    configureSidePanel();

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
});

// Configure the side panel when the service worker starts.
chrome.runtime.onStartup.addListener(() => {
    configureSidePanel();
});

/**
 * Open the side panel and pass it a pending bookmark request.
 *
 * IMPORTANT:
 * chrome.sidePanel.open() must be called while the context-menu
 * user gesture is still active. Therefore it MUST happen before
 * the asynchronous storage operation below.
 */
async function openAddFormInSidePanel(url, title, tabId) {
    try {
        // This must be the first async operation.
        await chrome.sidePanel.open({ tabId });

        await chrome.storage.session.set({
            pendingAddLink: {
                tabId,
                url,
                title: title || '',
                ts: Date.now(),
            },
        });
    } catch (error) {
        console.error(
            'Could not open the Linkding side panel:',
            error
        );
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/favicon128.png',
            title: 'Linkding',
            message: 'Click the Linkding icon to finish adding this bookmark.',
        });
    }
}

// Listener for the context menu
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'open-manager') {
        chrome.tabs.create({ url: 'manager.html' });
        return;
    }

    if (!tab?.id) return;

    if (info.menuItemId === 'bookmark-link') {
        if (!info.linkUrl) return;

        await openAddFormInSidePanel(
            info.linkUrl,
            info.selectionText || tab.title || info.linkUrl,
            tab.id
        );
    } else if (info.menuItemId === 'bookmark-page') {
        if (!tab?.url) return;

        await openAddFormInSidePanel(
            tab.url,
            tab.title,
            tab.id
        );
    }
});