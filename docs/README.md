# How Chrome Extensions Work

This document explains the architecture of Chrome extensions using the AI Roundtable project as a concrete example.

## Overview

Chrome extensions are small web applications that run in a **sandboxed environment** with special privileges to interact with the browser and web pages. They use the same web technologies (HTML, CSS, JavaScript) but have access to Chrome-specific APIs.

## The Manifest (`manifest.json`)

Every extension starts with a **manifest file** — the configuration that tells Chrome what the extension does and what permissions it needs:

```
┌─────────────────────────────────────────────┐
│              manifest.json                  │
├─────────────────────────────────────────────┤
│ • Name, version, description                │
│ • Permissions (tabs, storage, etc.)         │
│ • Which scripts run where                   │
│ • Icons, popup, side panel definitions      │
└─────────────────────────────────────────────┘
```

## Core Components

```
┌──────────────────────────────────────────────────────────────────┐
│                     CHROME BROWSER                                │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Background Service Worker                      │  │
│  │              (background.js)                                │  │
│  │  • Runs persistently (or on-demand in MV3)                 │  │
│  │  • Central message hub                                      │  │
│  │  • Can't access DOM directly                               │  │
│  └──────────────────────┬─────────────────────────────────────┘  │
│                         │                                         │
│         ┌───────────────┼───────────────┐                        │
│         ▼               ▼               ▼                        │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐                 │
│  │Content     │  │Content     │  │Content     │                 │
│  │Script      │  │Script      │  │Script      │                 │
│  │(claude.js) │  │(chatgpt.js)│  │(gemini.js) │                 │
│  │            │  │            │  │            │                 │
│  │Injected    │  │Injected    │  │Injected    │                 │
│  │into page   │  │into page   │  │into page   │                 │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘                 │
│        ▼               ▼               ▼                        │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐                 │
│  │  Claude    │  │  ChatGPT   │  │  Gemini    │                 │
│  │  Web Page  │  │  Web Page  │  │  Web Page  │                 │
│  └────────────┘  └────────────┘  └────────────┘                 │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Side Panel / Popup                             │  │
│  │              (panel.html + panel.js)                        │  │
│  │  • User interface                                           │  │
│  │  • Communicates with background                            │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Component Breakdown

| Component | File(s) | What It Does | Access |
|-----------|---------|--------------|--------|
| **Background Script** | `background.js` | Central coordinator, always available | Chrome APIs, NO DOM |
| **Content Scripts** | `claude.js`, `chatgpt.js`, `gemini.js` | Injected into web pages | Page DOM, limited Chrome APIs |
| **Side Panel/Popup** | `panel.html`, `panel.js` | User interface | Chrome APIs, own DOM only |

## Communication (Message Passing)

Components are **isolated** and must communicate via message passing:

```javascript
// From Side Panel → Background
chrome.runtime.sendMessage({ type: 'SEND_TO_AI', target: 'claude', text: 'Hello' });

// From Background → Content Script (specific tab)
chrome.tabs.sendMessage(tabId, { type: 'INJECT_MESSAGE', text: 'Hello' });

// Content Script → Background (response)
chrome.runtime.sendMessage({ type: 'RESPONSE_CAPTURED', response: '...' });
```

### Why This Isolation?

Security. Content scripts run in the context of potentially untrusted web pages. By isolating them:

- A malicious page can't access your extension's privileged APIs
- Content scripts can only do what they're explicitly allowed to do
- The background script acts as a secure "gatekeeper"

## Manifest V3 vs V2

This project uses **Manifest V3** (the current standard):

| Feature | MV2 (Legacy) | MV3 (Current) |
|---------|--------------|---------------|
| Background | Persistent page | Service Worker (event-driven) |
| Remote code | Allowed | Forbidden |
| Permissions | Broad | More granular |
| Performance | Higher memory | Lower memory |

## How AI Roundtable Uses This Architecture

```
User types in Side Panel
        │
        ▼
    panel.js sends message to background.js
        │
        ▼
    background.js finds the right AI tab
        │
        ▼
    background.js sends message to content script (e.g., claude.js)
        │
        ▼
    claude.js manipulates DOM:
      • Finds input field (contenteditable div)
      • Injects text
      • Clicks send button
      • Watches for response with MutationObserver
        │
        ▼
    claude.js sends captured response back to background.js
        │
        ▼
    background.js stores in chrome.storage.session
        │
        ▼
    panel.js updates UI with response
```

## Key Chrome APIs Used

| API | Purpose |
|-----|---------|
| `chrome.tabs` | Find and communicate with tabs |
| `chrome.runtime` | Message passing, extension lifecycle |
| `chrome.storage` | Persist data (session or local) |
| `chrome.sidePanel` | The side panel UI (MV3 feature) |

## Further Reading

- [Chrome Extensions Documentation](https://developer.chrome.com/docs/extensions/)
- [Manifest V3 Migration Guide](https://developer.chrome.com/docs/extensions/migrating/)
- [Chrome Extension Samples](https://github.com/GoogleChrome/chrome-extensions-samples)
