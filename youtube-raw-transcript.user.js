// ==UserScript==
// @name         Youtube Raw Transcript
// @description  A userscript that adds a button in the video's transcript panel, with the functionality of generating a raw video transcript you can copy-paste.
// @version      1.0.3
// @namespace    owowed.moe
// @author       owowed <island@owowed.moe>
// @homepage     https://github.com/owowed/owowed-userscripts
// @supportURL   https://github.com/owowed/owowed-userscripts/issues
// @match        *://www.youtube.com/*
// @require      https://github.com/owowed/userscript-common/raw/main/common.js
// @require      https://github.com/owowed/userscript-common/raw/main/mutation-observer.js
// @require      https://github.com/owowed/userscript-common/raw/main/wait-for-element.js
// @grant        GM_addStyle
// @license      LGPL-3.0
// @updateURL    https://github.com/owowed/owowed-userscripts/raw/main/youtube-raw-transcript.user.js
// @downloadURL  https://github.com/owowed/owowed-userscripts/raw/main/youtube-raw-transcript.user.js
// ==/UserScript==

// replace "document.isRTSDebug = false;" to "document.isRTSDebug = true;", to enable debug mode (console logging)
// (warning: enabling debug mode may degrade the userscript performance)
// (warning: enabling debug mode exposes `transcriptPanel` and `panels` variables to document.rtsDebug)
document.isRTSDebug = false;

const debugCategoryBlacklist = ["make-mutation-observer"];
const debugCategoryColors = {
    "page-info": "yellow",
    "event": "blue",
    "hook-repair": "green",
    "transcript-contains": "red",
    "transcript-panel-mutation": "aliceblue"
};

function debugLog(category, ...msg) {
    if (!document.isRTSDebug || debugCategoryBlacklist.includes(category)) return;
    if (debugCategoryColors[category]) {
        console.log(`%c[yt-raw-transcript] [${category}]`, `color: ${debugCategoryColors[category]};`, ...msg);
    }
    else {
        console.log(`[yt-raw-transcript] [${category}]`, ...msg);
    }
}

function debugLogLazy(category, ...msgOrDict) {
    if (!document.isRTSDebug || debugCategoryBlacklist.includes(category)) return;
    const consoleMsgArgs = [];
    for (const i of msgOrDict) {
        if (typeof i == "object" && i != null) {
            const resultDict = {};
            for (const [k, v] of Object.entries(i)) {
                if (typeof v == "function") {
                    resultDict[k] = v();
                }
                else resultDict[k] = v;
            }
            consoleMsgArgs.push(resultDict);
        }
        else if (typeof i == "function") {
            consoleMsgArgs.push(i());
        }
        else {
            consoleMsgArgs.push(i);
        }
    }
    debugLog(category, ...consoleMsgArgs);
}

let attachedElements = [];

{
    GM_addStyle(`
    #oxi-raw-transcript-button {
        background-color: var(--yt-spec-badge-chip-background);
        padding: 6px 10px;
        border: none;
        border-radius: 3px;
        color: var(--yt-spec-text-primary);
        font-family: "Roboto","Arial",sans-serif;
        cursor: pointer;
    }
    #oxi-raw-transcript-button:hover {
        backdrop-filter: brightness(1.4);
    }
    #oxi-raw-transcript-button:active {
        backdrop-filter: brightness(1.8);
    }
    ytd-transcript-search-panel-renderer > #header {
        padding: 0 0 12px 12px;
    }
    `);

    let panels,
        transcriptPanel,
        pageNavigateAbortController,
        transcriptPanelAbortController;
    let isFirstTime = true;

    document.addEventListener("yt-navigate-finish", event => eventCallback({ event }));
    document.addEventListener("readystatechange", event => eventCallback({ event }));

    async function eventCallback({ event, repairJob }) {
        const eventType = repairJob ? "repair-job" : event?.type;
        debugLog("event", `${eventType} event started`);
        debugLogLazy("page-info", window.location.href)

        pageNavigateAbortController?.abort(); // abort to avoid any memory leak
        pageNavigateAbortController = new AbortController();

        if (window.location.pathname.startsWith("/watch")) {
            debugLogLazy("event-watch-page", "window location pathname starts with watch",
                { isFirstTime, repairJob, panels, transcriptPanel,
                    isLastSignalAborted: transcriptPanelAbortController?.signal.aborted });
            if (!panels) {
                panels = await waitForElement(
                    "#secondary #panels",
                    { enableTimeout: false,
                        abortSignal: pageNavigateAbortController.signal });
                debugLog("event-watch-page", "got panels", { panels })
                makeMutationObserver({
                    target: panels,
                    childList: true
                }, ({ records }) => {
                    for (const record of records) {
                        // at very, very random scenario, transcriptPanel got removed
                        if (record.removedNodes.length > 0 && Array.from(record.removedNodes).includes(transcriptPanel)) {
                            transcriptPanel = null;
                            transcriptPanelAbortController.abort();
                            eventCallback({ repairJob: true });
                            debugLog("panels-removed-nodes", record.removedNodes);
                        }
                    }
                })
            }
            if (!isFirstTime && !repairJob && !panels.contains(transcriptPanel)) {
                debugLog("transcript-contains", "transcriptPanel somehow does not exist on panels...")
                transcriptPanel = null;
            }
            if (!transcriptPanel || repairJob) {
                transcriptPanelAbortController?.abort();
                transcriptPanelAbortController = new AbortController();

                transcriptPanel = await waitForElementByParent(
                    panels, `:scope > [target-id$="transcript"]`,
                    { enableTimeout: false,
                        abortSignal: transcriptPanelAbortController.signal });
                debugLog("event-watch-page", "got transcriptPanel", { transcriptPanel })

                let transcriptRenderer;

                makeMutationObserver(
                    { target: transcriptPanel,
                        abortSignal: transcriptPanelAbortController.signal,
                        attributes: true,
                        attributeFilter: ["visibility", "target-id"] },
                    ({ records, observer }) => {
                    for (const record of records) {
                        if (record.type != "attributes") continue;
                        const target = record.target;

                        if (record.attributeName == "visibility"
                            && target.getAttribute("visibility").endsWith("EXPANDED")) {
                            if (!transcriptRenderer || !transcriptPanel.contains(transcriptRenderer)) { // invalid transcriptRenderer
                                transcriptRenderer = null;
                                hookTranscriptRenderer();
                            }
                            else {
                                repairAttachedElements({ panels, transcriptPanel, transcriptRenderer });
                            }
                        }
                        else if (record.attributeName == "target-id"
                            && !target.getAttribute("target-id").endsWith("transcript")) {
                            debugLog("hook-repair", "invalid transcriptPanel, renewing transcriptPanel...")
                            transcriptPanel = null;
                            transcriptPanelAbortController.abort();
                            eventCallback({ repairJob: true });
                            observer.disconnect();
                        }

                        debugLog("transcript-panel-mutation", "transcript panel attributes",
                            { attributeName: record.attributeName,
                                targetId: target.getAttribute("target-id"),
                                visibility: target.getAttribute("visibility"),
                                transcriptPanel })
                    }
                });

                async function hookTranscriptRenderer() {
                    debugLog("hook", "hooking...");

                    if (!transcriptRenderer) {
                        transcriptRenderer = await waitForElementByParent(
                            transcriptPanel, "ytd-transcript-renderer",
                            { enableTimeout: false, abortSignal: transcriptPanelAbortController.signal });
                    }

                    attachElements({ transcriptPanel, transcriptRenderer });

                    const searchPanel = await waitForElementByParent(
                        transcriptRenderer, "ytd-transcript-search-panel-renderer > #header", 
                        { enableTimeout: false, abortSignal: transcriptPanelAbortController.signal });
                    
                    makeMutationObserver(
                        { target: searchPanel,
                            childList: true,
                            abortSignal: pageNavigateAbortController.signal },
                        ({ records }) => {
                            const target = records[0].target;
                            if (target.querySelector("#header > ytd-transcript-search-box-renderer")) {
                                repairAttachedElements({ panels, transcriptPanel, transcriptRenderer });
                            }
                        });
                }
            }
            // debug dump
            if (document.isRTSDebug) {
                document.rtsDebug = {}
                document.rtsDebug.panels = panels;
                document.rtsDebug.transcriptPanel = transcriptPanel;
            }
            isFirstTime = false;
            debugLog("event-watch-page",
                { isFirstTime, repairJob, panels, transcriptPanel,
                    panelsContainsTranscript: () => panels.contains(transcriptPanel),
                    isLastSignalAborted: transcriptPanelAbortController?.signal.aborted })
        }

        debugLog("event", `${eventType} event finished`);
    }
}

function isAttachedElementsBad({ parent = document.body }) {
    return attachedElements.length == 0 || !attachedElements.every(i => parent.contains(i));
}

function repairAttachedElements({ panels, transcriptPanel, transcriptRenderer }) {
    if (!isAttachedElementsBad({ parent: panels })) {
        debugLog("hook-repair", "hook aborted, attach elements is good")
        return;
    }
    debugLog("hook-repair", "repairing attached elements...");
    attachElements({ transcriptPanel, transcriptRenderer });
}

function attachElements(options) {
    debugLogLazy("attach-elements", "attaching elements...", { 
        attachedElements,
        attachedElementsDocuContains() {
            return attachedElements.reduce((dict, i) => {
                dict[`#${i.id}, class: "${i.className}", tagName: ${i.tagName}`] = document.body.contains(i);
                return dict;
            }, {})
        },
        ...options
    })
    attachedElements.forEach(i => i.remove());
    attachedElements = [];
    attachRawTranscriptButton(options);
    attachRawTranscriptTextArea(options);
    debugLog("attach-elements", "elements attached", { attachedElements })
}

function attachRawTranscriptButton({ transcriptRenderer }) {
    debugLog("attach-transcript-button", "transcript button attaching...", { transcriptRenderer });
    const panelHeader = transcriptRenderer.querySelector("ytd-transcript-search-panel-renderer #header");
    const rawTranscriptButton = document.createElement("button");

    rawTranscriptButton.id = "oxi-raw-transcript-button";
    rawTranscriptButton.textContent = "Raw Transcript";
    rawTranscriptButton.title = "Generate raw transcript. Raw transcript will be written in the textbox below the transcript panel."

    rawTranscriptButton.addEventListener("click", () => {
        const rawTranscript = getRawTranscript(transcriptRenderer);
        
        updateRawTranscriptTextArea(transcriptRenderer.rawTranscriptTextArea, rawTranscript);
    });

    debugLog("attach-transcript-button", "transcript button created", { panelHeader, rawTranscriptButton })

    panelHeader.append(rawTranscriptButton);
    attachedElements.push(rawTranscriptButton);

    debugLog("attach-transcript-button", "done attaching", { attachedElements })
}

function attachRawTranscriptTextArea({ transcriptPanel, transcriptRenderer }) {
    debugLog("attach-transcript-textarea", "transcript textarea attaching...", { transcriptPanel, transcriptRenderer })
    const textarea = document.createElement("textarea");

    textarea.id = "oxi-raw-transcript-textarea";
    textarea.rows = 20;
    textarea.placeholder = "(raw transcript will be written here)";

    debugLog("attach-transcript-textarea", "transcript textarea created", { textarea })

    transcriptPanel.insertAdjacentElement("afterend", textarea);
    transcriptRenderer.rawTranscriptTextArea = textarea;
    
    attachedElements.push(textarea);

    debugLog("attach-transcript-textarea", "done attaching", { attachedElements })
}

function updateRawTranscriptTextArea(rawTranscriptTextArea, text) {
    rawTranscriptTextArea.value = text;
}

function getRawTranscript(transcriptPanel) {
    const segmentTextNodeList = transcriptPanel.querySelectorAll("ytd-transcript-segment-renderer .segment-text");
    let text = "";

    for (const segmentTextNode of segmentTextNodeList) {
        text += `${segmentTextNode.textContent}\n`;
    }

    return text;
}
