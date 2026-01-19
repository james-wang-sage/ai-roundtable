# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

AI 圆桌 (AI Roundtable) is a Chrome extension (Manifest V3) that enables users to orchestrate multi-AI conversations between Claude, ChatGPT, and Gemini. It operates by injecting content scripts into AI web UIs to enable:
- Simultaneous message sending to multiple AIs
- Cross-referencing responses between AIs
- Mutual evaluation where all AIs critique each other's responses
- Multi-round discussion mode between two AIs

**Key architectural decision**: This extension deliberately uses web UI automation instead of APIs because web chat experiences often differ from API behavior due to model variants, hidden settings, and sampling parameters.

## Development Commands

### Loading the Extension
```bash
# 1. Navigate to chrome://extensions/
# 2. Enable "Developer mode" (top-right)
# 3. Click "Load unpacked"
# 4. Select the project directory
```

### After Making Changes
```bash
# Reload extension in chrome://extensions/ or use the keyboard shortcut
# Then refresh any AI tabs that are already open
```

### Testing
No automated tests exist. Manual testing workflow:
1. Open Claude, ChatGPT, and/or Gemini in separate tabs
2. Open extension sidepanel (click extension icon)
3. Verify connection status shows "Connected" for each AI
4. Test message sending, cross-referencing, and discussion modes

## Architecture

### Component Communication Flow
```
Side Panel (panel.js)
    ↕ chrome.runtime.sendMessage
Background Service Worker (background.js)
    ↕ chrome.tabs.sendMessage
Content Scripts (claude.js, chatgpt.js, gemini.js)
    ↕ DOM manipulation
AI Web Pages
```

### Core Components

**background.js** - Service Worker that:
- Routes messages between side panel and content scripts
- Maintains tab discovery for AI platforms via `AI_URL_PATTERNS`
- Stores latest responses in `chrome.storage.session` (survives service worker restarts)
- Notifies side panel of response captures

**content/*.js** - Platform-specific content scripts that:
- Inject messages into each AI's input field (DOM manipulation)
- Monitor for streaming completion using `MutationObserver`
- Capture response text while filtering out "thinking" blocks (Claude) or intermediate states
- Handle context invalidation (extension reloads/updates)
- Use 10-minute timeout for long responses with 2-second stability threshold

**sidepanel/panel.js** - UI controller that:
- Parses message syntax (`/mutual`, `/cross`, `@mentions`, `<-` arrows)
- Manages discussion mode state machine (initial → cross-eval → counter → summary)
- Handles three interaction modes: Normal (multi-send), Cross-reference (single-direction), Mutual Review (all evaluate all)

### Message Flow Patterns

**Normal Send**: Side panel → Background → Content script → DOM injection → Response observer → Background → Side panel

**Cross-reference**: Side panel requests response → Background queries content script → Side panel constructs XML-tagged message → Send to target AI

**Discussion Mode**: State machine coordinates multi-round exchanges with pending response tracking via `discussionState.pendingResponses`

## Key Implementation Details

### DOM Selectors are Fragile
Content scripts rely on platform-specific DOM selectors that break when AI providers update their UIs. When debugging "can't find input" errors:
- Check `inputSelectors` arrays in each content script
- Use browser DevTools to inspect current DOM structure
- Update selectors and test thoroughly
- Expected breakage on AI platform updates (per README "Known Limitations")

### Response Capture Logic
Each content script has unique response detection:
- **Claude**: Filters `.standard-markdown` blocks, excludes thinking blocks (`overflow-hidden`, `max-h-[238px]`, "Thought process" buttons)
- **ChatGPT**: Looks for `[data-message-author-role="assistant"]` containers
- **Gemini**: Uses `.model-response-text` or similar selectors

Waits for streaming completion via:
1. Check for streaming indicators (`[data-is-streaming="true"]`, Stop button)
2. Poll content every 500ms
3. Require 4 consecutive stable reads (2 seconds)
4. Max wait: 10 minutes

### Context Invalidation Handling
Extension updates/reloads invalidate content script contexts. All content scripts check `chrome.runtime.id` existence before sending messages to avoid errors. Users should refresh AI tabs after extension updates.

### Storage Strategy
- `chrome.storage.session`: Latest responses (persists across service worker lifecycle)
- No persistent storage - all data cleared on browser close
- No cloud sync, accounts, or data collection (privacy-first design per README)

## Message Syntax Reference

### /mutual Command
```
/mutual [optional evaluation prompt]
```
Triggers mutual review where each AI receives all other AIs' responses and evaluates them. Requires 2+ AIs with existing responses. Default prompt: "请评价以上观点。你同意什么？不同意什么？有什么补充？"

### Cross-reference Patterns

**Two AIs (auto-detect with evaluation keywords)**:
```
@Claude 评价一下 @ChatGPT
```
Last `@mention` = source (being evaluated), first = target (evaluator)

**Three+ AIs (requires explicit /cross)**:
```
/cross @Claude @Gemini <- @ChatGPT 评价一下
```
Before `<-` = targets (receivers), after `<-` = sources (being evaluated)

### Discussion Mode
Fixed 2-participant format. Rounds cycle through:
1. Initial: Both present their views
2. Cross-evaluation: Each critiques the other
3. Counter-response: Each responds to critique
4. Summary: Both generate discussion summaries

## Common Issues

### "No target found" / Connection Failed
1. Verify correct AI URL is open (see `AI_URL_PATTERNS` in background.js)
2. Refresh AI page after installing/updating extension
3. Check `chrome://extensions/` for errors in service worker console

### Cross-reference "Could not get response"
Ensure source AI has already replied. Extension queries DOM for latest response - if none exists, request fails.

### Responses Not Captured
1. Check content script console logs (`[AI Panel]` prefix)
2. Verify response selectors match current DOM (platforms change frequently)
3. Check for context invalidation messages
4. Refresh page to reinitialize content script

### Discussion Mode Stuck
Discussion state tracked in `discussionState.pendingResponses` Set. If AIs don't respond, manually end discussion and retry. No automatic timeout recovery.

## Code Patterns to Follow

### Adding Support for New AI Platform
1. Add URL pattern to `AI_URL_PATTERNS` in background.js
2. Create `content/newai.js` based on existing scripts
3. Implement platform-specific:
   - Input field selectors and injection logic
   - Response container selectors
   - Streaming detection indicators
4. Add content script entry to manifest.json
5. Update UI checkboxes in panel.html

### Message Sending Pattern
```javascript
// Always use chrome.runtime.sendMessage through background.js
chrome.runtime.sendMessage({
  type: 'SEND_MESSAGE',
  aiType: 'claude',
  message: 'Your message'
}, (response) => {
  if (response.success) {
    // Handle success
  }
});
```

### Safe Message Sending in Content Scripts
Always check context validity before messaging:
```javascript
function isContextValid() {
  return chrome.runtime && chrome.runtime.id;
}
```

## File Structure
```
ai-roundtable/
├── manifest.json           # Extension configuration (permissions, content scripts)
├── background.js           # Service Worker (message routing, tab discovery)
├── sidepanel/
│   ├── panel.html         # UI structure (checkboxes, textarea, discussion controls)
│   ├── panel.css          # Styling (AI-specific colors, layout)
│   └── panel.js           # Logic (message parsing, state management)
├── content/
│   ├── claude.js          # Claude DOM automation
│   ├── chatgpt.js         # ChatGPT DOM automation
│   └── gemini.js          # Gemini DOM automation
└── icons/                  # Extension icons (16-128px)
```

## Maintenance Philosophy

Per README, this is an experimental prototype focused on validating the "roundtable workflow" concept. Feature requests may not be implemented due to:
- Intentionally minimal scope
- No commitment to long-term maintenance
- DOM selectors inherently fragile to platform updates
- Focus on proving value of multi-AI deliberation pattern

When contributing:
- Keep changes small and focused
- Document any new DOM selectors with comments
- Test across all three AI platforms
- Update README if user-facing behavior changes
