# AI Roundtable (AI 圆桌) - Developer Guide

## Project Overview

**AI Roundtable** is a Chrome Extension (Manifest V3) that enables users to act as a "meeting host" for multiple AI assistants (Claude, ChatGPT, Gemini). It allows for simultaneous messaging, mutual evaluation, and deep discussion between models by directly automating their web interfaces.

**Key Philosophy:** This is an *experimental prototype* that operates on the **web UIs** of AI providers, not their APIs. This decision ensures the interaction matches the actual web experience users are familiar with, but it also makes the extension sensitive to DOM changes on those platforms.

## Architecture

The extension follows a standard Manifest V3 architecture with a focus on message routing and DOM manipulation.

### Core Components

1.  **Side Panel (`sidepanel/`)**:
    *   **`panel.html` & `panel.css`**: The main user interface.
    *   **`panel.js`**: The brain of the UI. Handles message parsing (commands like `/mutual`, `@mention`), manages the state machine for "Discussion Mode," and orchestrates complex multi-step interactions.
2.  **Service Worker (`background.js`)**:
    *   Acts as the central message router between the Side Panel and Content Scripts.
    *   Maintains tab discovery (finding open AI tabs).
    *   Stores the latest captured responses in `chrome.storage.session` to survive service worker restarts.
3.  **Content Scripts (`content/*.js`)**:
    *   **Files**: `claude.js`, `chatgpt.js`, `gemini.js`.
    *   **Role**: Injected into specific AI provider pages. They are responsible for:
        *   Injecting text into the chat input (DOM manipulation).
        *   Observing the DOM to detect when a response is complete (handling streaming states).
        *   Capturing the final response text.
    *   **Fragility**: Heavily reliant on specific DOM selectors (classes, IDs) which may change when AI providers update their UIs.

### Data Flow

*   **Sending**: Panel UI -> Background -> Content Script -> DOM Injection.
*   **Receiving**: Content Script (MutationObserver) -> Background -> Side Panel -> UI Update.

## Development Workflow

### Prerequisites
*   Chrome Browser.
*   No build tools (npm/webpack) are required. The project uses vanilla JavaScript.

### Setup & Running
1.  Navigate to `chrome://extensions/`.
2.  Enable **Developer mode** (top right toggle).
3.  Click **Load unpacked**.
4.  Select the root directory of this project (`/Volumes/Case_Sensitive/projects/ai-roundtable`).

### Iteration Cycle
1.  Make changes to the code.
2.  Go to `chrome://extensions/` and click the **Reload** icon for this extension.
3.  **Crucial Step**: Refresh any open Claude/ChatGPT/Gemini tabs to ensure the new content scripts are injected.

### Testing
*   **Manual Testing Only**: There are no automated tests.
*   **Standard Test Loop**:
    1.  Open Side Panel.
    2.  Check if AIs show as "Connected".
    3.  Send a "Hello" message to multiple AIs.
    4.  Test `/mutual` command after they respond.
    5.  Test Discussion Mode between two AIs.

## Codebase Conventions

*   **Language**: Vanilla JavaScript (ES6+), HTML5, CSS3.
*   **Style**: 
    *   2 spaces indentation.
    *   Semicolons are used.
    *   `SCREAMING_SNAKE_CASE` for constants.
    *   Feature-based file naming (e.g., `content/claude.js`).
*   **Safety Patterns**:
    *   **Context Validation**: Content scripts always check `chrome.runtime.id` before sending messages to avoid "Extension context invalidated" errors.
    *   **Error Handling**: Wrap message sending in try-catch blocks where appropriate.

## Key Features & Commands

*   **Normal Mode**: Send message to checked AIs.
*   **Mutual Review (`/mutual`)**: Trigger a round where AIs evaluate each other's last response.
*   **Cross-Reference (`@Target evaluate @Source`)**: One-way evaluation.
*   **Discussion Mode**: A dedicated UI mode for multi-round debate between two selected AIs.

## Troubleshooting & Maintenance

*   **"Selector not found"**: If an AI stops responding or receiving messages, it's likely their DOM structure changed. Inspect the page with DevTools and update the `inputSelectors` or response selectors in the relevant `content/*.js` file.
*   **"Extension context invalidated"**: Occurs after reloading the extension. **Must refresh the AI tabs.**
*   **Long Responses**: The system waits up to 10 minutes for a response, checking for stability (no changes for 2 seconds) to determine completion.

## Documentation
*   `README.md`: User-facing instructions and philosophy.
*   `AGENTS.md` / `WARP.md`: Detailed developer and architectural context.
*   `manifest.json`: Configuration and permissions.
