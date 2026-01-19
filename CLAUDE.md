# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI 圆桌 (AI Roundtable) is a Chrome extension (Manifest V3) that orchestrates multi-AI conversations between Claude, ChatGPT, and Gemini. It uses web UI automation (not APIs) because web chat behavior often differs from API behavior due to model variants and hidden settings.

## Development Commands

**No build system** - vanilla JavaScript extension. Load directly via Chrome:

```bash
# Load: chrome://extensions/ → Developer mode → Load unpacked → select project folder
# After changes: Reload extension + refresh AI tabs
```

**No automated tests** - manual testing only:
1. Open Claude/ChatGPT/Gemini in separate tabs
2. Click extension icon to open sidepanel
3. Verify "Connected" status for each AI
4. Test message sending, cross-referencing, discussion modes

## Architecture

```
Side Panel (panel.js)
    ↕ chrome.runtime.sendMessage
Background Service Worker (background.js)
    ↕ chrome.tabs.sendMessage
Content Scripts (claude.js, chatgpt.js, gemini.js)
    ↕ DOM manipulation
AI Web Pages
```

**background.js**: Message routing hub, tab discovery via `AI_URL_PATTERNS`, stores responses in `chrome.storage.session`

**content/*.js**: Platform-specific DOM automation - message injection, response capture via `MutationObserver` + polling (4 stable reads over 2 seconds, 10-minute timeout)

**sidepanel/panel.js**: UI controller, message syntax parsing (`/mutual`, `/cross`, `@mentions`, `<-` arrows), discussion mode state machine

## Critical Implementation Details

### DOM Selectors are Fragile
Content scripts use platform-specific selectors that break when AI providers update their UIs:
- **Claude**: `div[contenteditable="true"].ProseMirror` (input), `.standard-markdown` (response, excludes thinking blocks)
- **ChatGPT**: `#prompt-textarea` (input), `[data-message-author-role="assistant"]` (response)
- **Gemini**: `.ql-editor` or `div[contenteditable="true"]` (input), `.model-response-text` (response)

When debugging connection failures, inspect current DOM structure and update selectors.

### Context Invalidation
Extension updates invalidate content script contexts. All content scripts check `chrome.runtime.id` before messaging. Users must refresh AI tabs after extension updates.

### Message Syntax

**Mutual review**: `/mutual [optional prompt]` - all AIs evaluate each other

**Cross-reference** (2 AIs): `@Claude 评价一下 @ChatGPT` - last mention = source, first = target

**Cross-reference** (3+ AIs): `/cross @Claude @Gemini <- @ChatGPT` - before `<-` = targets, after = sources

### Discussion Mode State
Fixed 2-participant format cycling: initial views → cross-evaluation → counter-response → summary. State tracked in `discussionState` object with `pendingResponses` Set.

## Adding a New AI Platform

1. Add URL pattern to `AI_URL_PATTERNS` in `background.js`
2. Create `content/newai.js` with platform-specific selectors for input, send button, response containers, streaming detection
3. Add content script entry to `manifest.json`
4. Add UI checkbox to `sidepanel/panel.html`

## Debugging

- Service worker logs: `chrome://extensions/` → service worker console
- Content script logs: Browser DevTools on AI pages (prefix: `[AI Panel]`)
- "No target found": Check AI_URL_PATTERNS, refresh AI page
- Responses not captured: DOM selectors likely changed, inspect and update
