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
        contexts: ['action'],
    });

    // Add a context menu item for bookmarking links
    chrome.contextMenus.create({
        id: 'bookmark-link',
        title: 'Bookmark this link in Linkding',
        contexts: ['link'],
    });

    // Add a context menu item for bookmarking the current page
    chrome.contextMenus.create({
        id: 'bookmark-page',
        title: 'Bookmark this page in Linkding',
        contexts: ['page'],
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

async function captureVisibleTab(windowId) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
        } catch (error) {
            if (!error.message?.includes("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND")) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 600));
        }
    }
    throw new Error("Exceeded captureVisibleTab quota after retries.");
}

/**
 * Capture a full-page screenshot from the specified tab.
 *
 * The screenshot is returned as a data URL:
 *   data:image/png;base64,...
 *
 * @param {number} tabId
 * @returns {Promise<string>}
 */
async function captureFullPageScreenshot(tabId) {
    const tab = await chrome.tabs.get(tabId);
    const target = { tabId };
    let attached = false;

    try {
        await chrome.debugger.attach(target, "1.3");
        attached = true;

        const response = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
            expression: `(() => {
                const d = document.documentElement;
                const b = document.body;
                const max = (...v) => Math.max(...v.filter(Boolean));

                return {
                    width: max(d.clientWidth, d.scrollWidth, d.offsetWidth,
                        b?.scrollWidth, b?.offsetWidth),
                    height: max(d.clientHeight, d.scrollHeight, d.offsetHeight,
                        b?.scrollHeight, b?.offsetHeight),
                    viewportWidth: innerWidth,
                    viewportHeight: innerHeight,
                    scrollX: scrollX,
                    scrollY: scrollY
                };
            })()`,
            returnByValue: true
        });

        const page = response?.result?.value;

        if (!page) {
            throw new Error(`Failed to determine page dimensions: ${JSON.stringify(response)}`);
        }

        const {
            width,
            height,
            viewportWidth,
            viewportHeight,
            scrollX,
            scrollY
        } = page;

        const overlap = Math.min(200, viewportHeight - 1);
        const yStep = viewportHeight - overlap;
        const positions = [];

        for (let y = Math.max(0, height - viewportHeight); y >= 0; y -= yStep) {
            positions.push(Math.max(0, y));

            if (y === 0) break;
        }

        positions.reverse();

        const images = [];

        // Scroll and capture each viewport.
        for (const y of positions) {
            await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
                expression: `scrollTo(0, ${y})`,
                returnByValue: true
            });

            await new Promise(resolve => setTimeout(resolve, 550));

            const data = await captureVisibleTab(tab.windowId);

            if (!data) {
                throw new Error(`Failed to capture viewport at y=${y}`);
            }

            images.push({ data, y });
        }

        // Decode the first image to determine device-pixel scaling.
        const first = await createImageBitmap(
            await (await fetch(images[0].data)).blob()
        );

        const scale = first.width / viewportWidth;
        const canvas = new OffscreenCanvas(
            Math.round(width * scale),
            Math.round(height * scale)
        );
        const ctx = canvas.getContext("2d");

        if (!ctx) {
            throw new Error("Unable to create screenshot canvas.");
        }

        for (const { data, y } of images) {
            const image = await createImageBitmap(
                await (await fetch(data)).blob()
            );

            ctx.drawImage(
                image,
                0,
                0,
                image.width,
                image.height,
                0,
                Math.round(y * scale),
                image.width,
                image.height
            );

            image.close();
        }

        const blob = await canvas.convertToBlob({ type: "image/png" });
        const bytes = new Uint8Array(await blob.arrayBuffer());

        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }

        return `data:image/png;base64,${btoa(binary)}`;
    } finally {
        if (attached) {
            try {
                await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
                    expression: `scrollTo(${scrollX ?? 0}, ${scrollY ?? 0})`
                });
            } catch {}

            try {
                await chrome.debugger.detach(target);
            } catch {}
        }
    }
}

/**
 * Capture a screenshot and return it to the extension page that
 * requested it.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'capture-full-page-screenshot') {
        return false;
    }

    const tabId = message.tabId;

    if (!tabId) {
        sendResponse({ success: false, error: 'No tab ID was supplied.' });
        return false;
    }

    captureFullPageScreenshot(tabId)
        .then((dataUrl) => { sendResponse({ success: true, dataUrl }); })
        .catch((error) => {
            console.error('Could not capture full-page screenshot:', error);
            sendResponse({ success: false, error: error.message || 'Screenshot capture failed.' });
        });

    return true;
});