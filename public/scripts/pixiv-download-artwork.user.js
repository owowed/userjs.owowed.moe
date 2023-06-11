// ==UserScript==
// @name         Pixiv Download Artwork
// @description  A userscript that adds a button, that can download the current artwork, with customizable filename.
// @version      1.2.2
// @namespace    owowed.moe
// @author       owowed <island@owowed.moe>
// @homepage     https://github.com/owowed/owowed-userscripts
// @supportURL   https://github.com/owowed/owowed-userscripts/issues
// @match        *://www.pixiv.net/*/artworks/*
// @match        *://www.pixiv.net/*
// @require      https://github.com/owowed/userscript-common/raw/main/common.js
// @require      https://github.com/owowed/userscript-common/raw/main/mutation-observer.js
// @require      https://github.com/owowed/userscript-common/raw/main/wait-for-element.js
// @require      https://code.jquery.com/jquery-3.6.4.slim.min.js
// @grant        GM_addStyle
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @license      LGPL-3.0
// @updateURL    https://github.com/owowed/owowed-userscripts/raw/main/pixiv-download-artwork.user.js
// @downloadURL  https://github.com/owowed/owowed-userscripts/raw/main/pixiv-download-artwork.user.js
// ==/UserScript==

/*
    "@match *://www.pixiv.net/*" is for adding download for user who navigated from pixiv homepage to pixiv artwork page
    pixiv changes their webpage by javascript, not by redirecting to a new page
*/

GM_addStyle(`
    #oxi-artwork-toolbar {
        display: flex;
        flex-flow: column;
    }
    #oxi-artwork-toolbar > * {
        margin-bottom: 7px;
    }
    #oxi-artwork-toolbar > label:has(+ *) {
        margin-bottom: 2px;
    }
    #oxi-artwork-part-selector {
        width: 240px;
    }
    #oxi-artwork-download-btn {
        width: fit-content;
        height: fit-content;
    }
    #oxi-artwork-image-filename {
        width: 640px;
        font-family: monospace;
    }
`);

const IMAGE_FILENAME_TOOLTIP_GUIDE = `There are few variables available in the filename to use:
    %artworkId% - Artwork Pixiv id
    %artworkTitle% - Artwork title 
    %artworkAuthorName% - Author name
    %artworkAuthorId% - Author Pixiv id
    %artworkCreationDate% - Artwork creation date that is shown in the webpage
    %artworkPartNum% - Artwork part number when downloading from multiple artworks (if you download the first artwork, then it will be "0")
    %imageFileExtension% - Image file type taken from the URL (the file extension does not include dot)
    %artworkLikeCount% - Artwork's like count
    %artworkBookmarkCount% - Artwork's bookmark count
    %artworkViewCount% - Artwork's view count
    %imageDateFromUrlPath% - Image creation date that is shown in the URL path (may not be correct, the hour time is +1 off)
    %imageOriginalFilename% - Image original filename that is shown in the URL path
    %webLang% - The website's language when you visit the artwork (taken from the URL path)`;

const DEFAULT_IMAGE_FILENAME = "%artworkTitle% by %artworkAuthorName% #%artworkPartNum% [pixiv %artworkId%].%imageFileExtension%";

function formatFilename(filename, formatData) {
    for (const [k, v] of Object.entries(formatData)) {
        filename = filename.replace(`%${k}%`, v);
    }
    return filename;
}

function getFilenameImageFormatData({ imageUrl, selectedPartNum }) {
    const formatData = {};

    // Artwork Selected Part Number
    formatData.artworkPartNum = selectedPartNum;
    
    // Image File Extension
    formatData.imageFileExtension = imageUrl.split(".").at(-1);

    // Image Date from Image's URL path
    formatData.imageDateFromUrlPath = imageUrl
        .split("/img/")[1]
        .split("/").slice(0, -1).join("/");
    
    // Image Original Name from Image's URL path
    formatData.imageOriginalFilename = imageUrl.split("/").at(-1);

    return formatData;
}

async function getFilenamePageFormatData() {
    const formatData = {};

    // Artwork Id
    formatData.artworkId = window.location.href.split("works/")[1];

    // Artwork Descriptor (cached element)
    const artworkDescriptor = await waitForElement("figcaption:has(h1, footer)");

    // Artwork Title
    formatData.artworkTitle = await waitForElementByParent(artworkDescriptor, "h1").then(i => i.textContent);

    // Artwork Author Profile (cached element)
    const authorProfile = await waitForElement("div:has(> button[data-click-label='follow'])");

    // Artwork Author Link (cached element)
    const authorLink = await waitForElementByParent(authorProfile, "a[data-gtm-value]:not(:has(img))");

    // Artwork Author Name
    formatData.artworkAuthorName = await waitForElementByParent(authorLink, ":scope > div")
        .then(i => i.textContent);

    // Artwork Author Id
    formatData.artworkAuthorId = authorLink.href.split("users/")[1];

    // Artwork Creation Date
    formatData.artworkCreationDate = await waitForElementByParent(artworkDescriptor, "[title='Posting date']")
        .then(i => i.textContent);

    // Artwork Like, Bookmark, View Count
    const parseIntSafe = (i) => parseInt(i.textContent.replace(/[^\d]/g, ""));
    formatData.artworkLikeCount = await waitForElementByParent(artworkDescriptor, "[title=Like]")
        .then(parseIntSafe);
    formatData.artworkBookmarkCount = await waitForElementByParent(artworkDescriptor, "[title=Bookmarks]")
        .then(parseIntSafe);
    formatData.artworkViewCount = await waitForElementByParent(artworkDescriptor, "[title=Views]")
        .then(parseIntSafe);

    // Website's Languange from URL path
    formatData.webLang = window.location.href.split("/")[3];

    return formatData;
}

class ToolbarPatch {
    patcher;

    toolbarElem;
    downloadBtnElem;
    imageFilenameElem;
    artworkPartSelectorElem;
    downloadProgressContainerElem;
    
    // artwork-navigate scope
    artworkDescriptor;
    artworkDescriptorFooter;
    artworkContainer;
    selectedArtworkPart;
    bulkDownloadArtworks = false;

    #GM_DOWNLOAD_OPTIONS_TEMPLATE = {
        saveAs: false,
        headers: {
            Referer: "https://www.pixiv.net/"
        },
    };
    #GM_DOWNLOAD_MAX_RETRY_ATTEMPT = 8;

    constructor () {
        this.toolbarElem = $("<div>", { id: "oxi-artwork-toolbar", hidden: true })[0];

        this.downloadBtnElem = $("<button>", { id: "oxi-artwork-download-btn", text: "Download Artwork" })
            .on("click", () => {
                if (!this.bulkDownloadArtworks) {
                    this.#downloadArtworkParts(this.#getArtworkParts().slice(0, 1));
                }
                else {
                    this.#downloadArtworkParts(this.#getArtworkParts());
                }
            })[0];
        
        this.imageFilenameElem = $("<textarea>",
                { id: "oxi-artwork-image-filename",
                    title: IMAGE_FILENAME_TOOLTIP_GUIDE,
                    placeholder: "Enter image filename...",
                    spellcheck: false })
            .val(GM_getValue("image_filename"))
            .on("keyup change", () => {
                GM_setValue("image_filename", this.imageFilenameElem.value)
            })[0];
        
        this.artworkPartSelectorElem = $("<select>", { id: "oxi-artwork-part-selector" })
            .on("input", () => {
                if (this.artworkPartSelectorElem.value == "bulk-download-artworks") {
                    this.bulkDownloadArtworks = true;
                }
                else {
                    const [ index, ...href ] = this.artworkPartSelectorElem.value.split(":");
                    this.selectedArtworkPart = { index: parseInt(index), href: href.join(":") };
                }
            })[0];
        
        this.downloadProgressContainerElem = document.createElement("div");

        const imageFilenameLabel = $("<label>", { text: "Image Filename Template:" })[0];
        const selectorLabel = $("<label>", { text: "Selected Artwork Part:" })[0];

        $(this.toolbarElem).append([
            imageFilenameLabel,
            this.imageFilenameElem,
            selectorLabel,
            this.artworkPartSelectorElem,
            this.downloadBtnElem,
            this.downloadProgressContainerElem,
        ]);
    }

    #waitMoreThanOneImageLoaded() {
        return new Promise((resolve) => {
            const imageContainer = this.artworkContainer.querySelector("div");

            makeMutationObserver({ target: imageContainer, childList: true, once: true }, () => {
                resolve(true);
            });
        })
    }

    async #downloadArtworkParts(artworkPartList) {
        this.#displayDownloadProgress({ id: "title", state: "starting", text: "Initiliazing artwork download..." });

        let downloadQueue = [...artworkPartList];
        let retryCounter = 0;
        
        const pageFormatData = await getFilenamePageFormatData();

        while (downloadQueue.length > 0 && retryCounter < this.#GM_DOWNLOAD_MAX_RETRY_ATTEMPT) {
            if (retryCounter > 0) {
                this.#displayDownloadProgress({ id: "title", text: `Some of the download had failed, retrying download... ${getProgressInfoText()}` });
            }
            
            const promises = [];
            
            let progressCounter = {};
            let downloadedArtworkCounter = 0;

            const getProgressInfoText = ({ index }) => `(${progressCounter[index]} progress)`;
            const getTotalProgressInfoText = () => `(${downloadedArtworkCounter} out of ${artworkPartList.length} artworks)`;

            for (const artworkPart of downloadQueue) {
                const { index, href } = artworkPart;
                
                progressCounter[index] = 0;

                const promise = new Promise((resolve) => {
                    const downloadOptions = {
                        ...this.#GM_DOWNLOAD_OPTIONS_TEMPLATE,
                        name: formatFilename(GM_getValue("image_filename") ?? DEFAULT_IMAGE_FILENAME, { ...pageFormatData, ...getFilenameImageFormatData({ selectedPartNum: index, imageUrl: href }) }),
                        url: href,
                        onload: () => {
                            downloadedArtworkCounter++;
                            downloadQueue.splice(downloadQueue.indexOf(artworkPart), 1);
                            this.#displayDownloadProgress({ id: index, text: `Artwork #${index} download complete! ${getProgressInfoText({ index })}` });
                            resolve();
                        },
                        onprogress: () => {
                            progressCounter[index]++;
                            this.#displayDownloadProgress({ id: "title", text: `Downloading artworks... ${getTotalProgressInfoText()}` });
                            this.#displayDownloadProgress({ id: index, text: `Downloading Artwork #${index}... ${getProgressInfoText({ index })}` });
                        },
                        onerror: () => {
                            dbg(`download error: artwork #${index} ${getProgressInfoText({ index })}`);
                            this.#displayDownloadProgress({ id: index, text: `Failed to download Artwork #${index} due to an error. ${getProgressInfoText({ index })}` });
                            resolve();
                        },
                        ontimeout: () => {
                            dbg(`download timeout error: artwork #${index} ${getProgressInfoText({ index })}`);
                            this.#displayDownloadProgress({ id: index, text: `Failed to download Artwork #${index} due to a timeout error. ${getProgressInfoText({ index })}` });
                            resolve();
                        }
                    }
                    
                    GM_download(downloadOptions);
                });

                promises.push(promise);
            }

            await Promise.all(promises);
            retryCounter++;
        }

        const getDownloadConclusionText = () => `(${artworkPartList.length} artworks)`;

        if (downloadQueue.length > 0) {
            this.#displayDownloadProgress({ id: "title", text: `Download complete, but some artwork cannot be downloaded due to an error. ${getDownloadConclusionText()}` });
        }
        else {
            this.#displayDownloadProgress({ id: "title", text: `All artworks has been successfully downloaded! ${getDownloadConclusionText()}` });
        }
    }

    #progressElements = {};

    #displayDownloadProgress({ id, text }) {
        if (!this.#progressElements[id]) {
            const elem = document.createElement("div");
            this.downloadProgressContainerElem.append(elem);
            this.#progressElements[id] = elem;
        }

        this.#progressElements[id].textContent = text;
    }

    #clearDownloadProgress() {
        for (const val of Object.values(this.#progressElements)) {
            val.remove();
        }
        this.#progressElements = {};
    }

    #getArtworkParts() {
        const anchors = this.artworkContainer.querySelectorAll(`div > a`);
        const artworkParts = [];

        let counter = 0;
        for (const anchor of anchors) {
            artworkParts.push({ index: counter + 1, href: anchor.href });
            counter++;
        }

        return artworkParts;
    }

    #updateArtworkSelectorOptions(artworkParts) {
        this.artworkPartSelectorElem.innerHTML = "";
        for (const { index, href } of artworkParts) {
            this.artworkPartSelectorElem.append(
                $("<option>", { text: `Artwork #${index}`, value: `${index}:${href}` })[0]
            );
        }
    }

    patch(patcher) {
        this.patcher = patcher;

        const artworkNavigateStartPromise = new Promise((resolve) => {
            patcher.eventTarget.addEventListener("artwork-navigate-start", async () => {
                this.artworkDescriptor = await waitForElement("figcaption:has(h1):has(footer)");
                this.artworkDescriptorFooter = this.artworkDescriptor.querySelector("footer");
                this.artworkContainer = await waitForElement(`figure:has(> div > div > div > a)`);

                await new Promise(resolve => setTimeout(resolve, 1000));

                this.artworkDescriptorFooter.insertAdjacentElement("beforebegin", this.toolbarElem);
                this.toolbarElem.hidden = false;

                resolve();
            });
        });

        patcher.eventTarget.addEventListener("artwork-navigate", async () => {
            await artworkNavigateStartPromise;
            const artworkParts = this.#getArtworkParts();
            this.selectedArtworkPart = artworkParts[0];

            this.#updateArtworkSelectorOptions(artworkParts);

            this.artworkPartSelectorElem.append(
                $("<option>", { text: `If there is more than one artwork, then click "Show all" button for other artworks to automatically appear here.`, disabled: true })[0]
            );

            makeMutationObserver({ target: this.artworkContainer, childList: true, once: true }, async () => {
                await this.#waitMoreThanOneImageLoaded();
                this.#updateArtworkSelectorOptions(this.#getArtworkParts());
                this.artworkPartSelectorElem.append(
                    $("<option>", { text: "Bulk Download All Artworks", value: "bulk-download-artworks" })[0]
                );
            });

            this.#clearDownloadProgress();
        });
    }
}

class PixivPatcher {
    eventTarget = new EventTarget;

    constructor () {
        this.#initWholeNavigateEvent();
        this.#initArtworkNavigateEvent();
    }

    async #initWholeNavigateEvent() {
        const charcoalPage = await waitForElement(".charcoal-token > div");

        makeMutationObserver({ target: charcoalPage, childList: true }, () => {
            this.eventTarget.dispatchEvent(new Event("whole-navigate"));
        });

        if (document.readyState == "loading") {
            document.addEventListener("DOMContentLoaded", () => {
                this.eventTarget.dispatchEvent(new Event("whole-navigate"));
            });
        }
        else {
            this.eventTarget.dispatchEvent(new Event("whole-navigate"));
        }
    }
    
    #initArtworkNavigateEvent() {
        this.eventTarget.addEventListener("whole-navigate", async () => {
            if (!window.location.href.includes("/artworks/")) return;

            this.eventTarget.dispatchEvent(new Event("artwork-navigate-start"));
            this.eventTarget.dispatchEvent(new Event("artwork-navigate"));
            
            const artworkPanel = await waitForElement("div:has(> figure):has(> figcaption)");

            const observer = makeMutationObserver({ target: artworkPanel, childList: true }, () => {
                this.eventTarget.dispatchEvent(new Event("artwork-navigate"));
            });

            this.eventTarget.addEventListener("whole-navigate", () => {
                observer.disconnect();
                this.eventTarget.addEventListener("artwork-navigate-end");
            }, { once: true });
        });
    }

    addPatches(patches) {
        for (const patch of patches) {
            patch.patch(this);
        }
    }
}

void async function main() {
    const patcher = new PixivPatcher;

    patcher.addPatches([
        new ToolbarPatch
    ]);
}();

function dbg(...obj) {
    console.debug("[pixiv download artwork userscript debug]", ...obj);
    return obj.at(-1);
}
