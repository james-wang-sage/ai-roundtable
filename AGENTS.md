# AI Roundtable - Agent Guidelines

A Chrome extension enabling multi-AI roundtable discussions with Claude, ChatGPT, and Gemini.

## Project Overview

- **Type**: Chrome Extension (Manifest V3)
- **Language**: Vanilla JavaScript, HTML, CSS (no build system, no framework)
- **Architecture**: Service worker + Content scripts + Side panel UI

## Project Structure

```
ai-roundtable/
├── manifest.json           # Extension config (Manifest V3)
├── background.js           # Service worker: tab discovery, message routing
├── sidepanel/
│   ├── panel.html         # Side panel UI structure
│   ├── panel.css          # Axton brand styling (Deep Space Violet theme)
│   └── panel.js           # Panel controller, discussion logic
├── content/
│   ├── claude.js          # Claude.ai content script
│   ├── chatgpt.js         # ChatGPT content script
│   └── gemini.js          # Gemini content script
├── icons/                  # Extension icons (16, 32, 48, 128)
└── docs/                   # Documentation (currently empty)
```

## Build, Test & Development

### No Build System
Load directly as unpacked extension - no npm, no bundler.

### Loading the Extension
1. Open `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select repository root

### Development Workflow
1. Make code changes
2. Click "Reload" on `chrome://extensions/` page
3. Refresh any open AI tabs (Claude, ChatGPT, Gemini)
4. Open side panel to test

### Manual Testing Checklist
- [ ] Open Claude/ChatGPT/Gemini tabs
- [ ] Open side panel (click extension icon)
- [ ] Verify "Connected" status for each AI
- [ ] Send a message to multiple AIs
- [ ] Test `/mutual` command (peer review)
- [ ] Test `/cross` command (cross-reference)
- [ ] Test Discussion mode (2 AI debate)

### Regression Focus Areas
- DOM selectors in `content/*.js` (AI UIs change frequently)
- Message parsing in `sidepanel/panel.js` (`parseMessage()`)
- Response capture timing in content scripts

## Code Style

### JavaScript
- **Indentation**: 2 spaces
- **Semicolons**: Always use
- **Quotes**: Single quotes preferred, double for HTML attributes
- **IIFE Pattern**: Content scripts use `(function() { 'use strict'; ... })();`

### Naming Conventions
```javascript
// Constants: SCREAMING_SNAKE_CASE
const AI_URL_PATTERNS = { ... };
const MAX_WAIT = 600000;

// Variables/Functions: camelCase
let discussionState = { ... };
async function handleCrossReference(parsed) { ... }

// DOM IDs: kebab-case
document.getElementById('message-input');
document.getElementById('target-claude');

// CSS Classes: kebab-case
.target-label, .mode-btn, .discussion-status
```

### File Naming
- Lowercase with hyphens: `panel.js`, `panel.css`
- Feature-based in `content/`: `claude.js`, `chatgpt.js`, `gemini.js`

### Function Patterns

**Async message handling:**
```javascript
async function handleMessage(message, sender) {
  switch (message.type) {
    case 'SEND_MESSAGE':
      return await sendMessageToAI(message.aiType, message.message);
    // ...
  }
}
```

**Safe Chrome API calls (content scripts):**
```javascript
function isContextValid() {
  return chrome.runtime && chrome.runtime.id;
}

function safeSendMessage(message, callback) {
  if (!isContextValid()) {
    console.log('[AI Panel] Extension context invalidated');
    return;
  }
  try {
    chrome.runtime.sendMessage(message, callback);
  } catch (e) {
    console.log('[AI Panel] Failed:', e.message);
  }
}
```

**Response observers with cleanup:**
```javascript
const observer = new MutationObserver((mutations) => {
  if (!isContextValid()) {
    observer.disconnect();
    return;
  }
  // ... handle mutations
});
```

### Error Handling
- Log errors with `[AI Panel]` prefix for debugging
- Never throw from message handlers; return error objects
- Use try/catch for Chrome API calls in content scripts

### DOM Selectors
- Comment non-obvious selectors
- Keep selector arrays for fallback (AI UIs change often)
```javascript
const inputSelectors = [
  'div[contenteditable="true"].ProseMirror',  // Primary Claude input
  'div.ProseMirror[contenteditable="true"]',  // Alternative
  '[data-placeholder="How can Claude help you today?"]',  // Placeholder-based
  'fieldset div[contenteditable="true"]'  // Form-based fallback
];
```

### CSS (Axton Brand Theme)
```css
:root {
  --deep-space-violet: #2F2B42;
  --electric-cyan: #4AFAFF;
  --vibrant-orange: #FF5722;
  --dark-card: #2d3748;
  --text-primary: #FFFFFF;
  --text-secondary: rgba(255, 255, 255, 0.85);
  --text-muted: rgba(255, 255, 255, 0.6);
}
```

## Message Protocol

### Message Types (background.js hub)
| Type | Direction | Purpose |
|------|-----------|---------|
| `SEND_MESSAGE` | Panel -> Background -> Content | Inject message to AI |
| `GET_RESPONSE` | Panel -> Background -> Content | Fetch latest response |
| `RESPONSE_CAPTURED` | Content -> Background -> Panel | Notify response ready |
| `CONTENT_SCRIPT_READY` | Content -> Background | Script loaded |
| `TAB_STATUS_UPDATE` | Background -> Panel | Connection status |

### Response Object Patterns
```javascript
// Success
{ success: true }

// Failure
{ success: false, error: 'Error message' }

// Content response
{ content: 'AI response text' }
```

## Content Script Architecture

Each content script (`claude.js`, `chatgpt.js`, `gemini.js`) follows the same pattern:

1. **Initialization**: Notify background script ready
2. **Message Listener**: Handle `INJECT_MESSAGE`, `GET_LATEST_RESPONSE`
3. **Response Observer**: MutationObserver watching for AI responses
4. **Streaming Detection**: Wait for response completion before capture

### Key Timing Constants
```javascript
const MAX_WAIT = 600000;       // 10 minutes max response time
const CHECK_INTERVAL = 500;    // 500ms polling
const STABLE_THRESHOLD = 4;    // 2 seconds stable = complete
```

## Commit Guidelines

### Conventional Commits (preferred)
```
feat: Add /mutual command for peer review
fix: DOM selector update for Claude UI changes
docs: Update testing checklist
chore: Update manifest version
```

### Commit Scope
- Keep commits small, single-purpose
- DOM selector changes should note which AI and why

### PR Requirements
- Short description of change
- Reproduction steps for bugs
- Screenshots/recordings for UI changes
- Note any DOM selector updates

## Security & Privacy

- **No external network calls** - Extension runs entirely locally
- **No telemetry/analytics** - No data collection
- **Local storage only** - `chrome.storage.local` and `chrome.storage.session`
- Never add API keys, credentials, or external service calls

## Known Fragility

### DOM Selectors (HIGH PRIORITY)
AI web UIs update frequently. When selectors break:
1. Inspect the AI page to find new selectors
2. Update the selector array in the relevant content script
3. Test thoroughly before committing
4. Document the change in the PR

### Response Capture Timing
If responses aren't being captured:
1. Check streaming detection logic
2. Verify stable content threshold
3. Confirm MutationObserver is watching correct container

## Common Tasks

### Adding a New AI Provider
1. Create `content/newai.js` following existing pattern
2. Add URL pattern to `manifest.json` content_scripts
3. Add URL pattern to `background.js` `AI_URL_PATTERNS`
4. Add checkbox/UI elements to `sidepanel/panel.html`
5. Add styling to `sidepanel/panel.css`
6. Update `AI_TYPES` array in `sidepanel/panel.js`

### Updating DOM Selectors
1. Open browser DevTools on the AI page
2. Inspect the input field / response container
3. Find stable selectors (prefer data attributes over classes)
4. Update selector arrays with fallbacks
5. Test send and response capture

### Debugging Response Capture
1. Open DevTools console on AI page
2. Look for `[AI Panel]` prefixed logs
3. Check `waitForStreamingComplete()` flow
4. Verify `getLatestResponse()` returns content
