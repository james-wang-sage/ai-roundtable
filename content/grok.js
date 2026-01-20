// AI Panel - Grok Content Script
// Based on research: Grok uses ProseMirror contenteditable (similar to Claude)
// Selectors may need adjustment after manual inspection of grok.com

(function() {
  'use strict';

  const AI_TYPE = 'grok';

  // Check if extension context is still valid
  function isContextValid() {
    return chrome.runtime && chrome.runtime.id;
  }

  // Safe message sender that checks context first
  function safeSendMessage(message, callback) {
    if (!isContextValid()) {
      console.log('[AI Panel] Extension context invalidated, skipping message');
      return;
    }
    try {
      chrome.runtime.sendMessage(message, callback);
    } catch (e) {
      console.log('[AI Panel] Failed to send message:', e.message);
    }
  }

  // Notify background that content script is ready
  safeSendMessage({ type: 'CONTENT_SCRIPT_READY', aiType: AI_TYPE });

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'INJECT_MESSAGE') {
      injectMessage(message.message)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (message.type === 'GET_LATEST_RESPONSE') {
      const response = getLatestResponse();
      sendResponse({ content: response });
      return true;
    }
  });

  // Setup response observer for cross-reference feature
  setupResponseObserver();

  async function injectMessage(text) {
    // Grok likely uses ProseMirror contenteditable (based on research)
    // These selectors are based on web research - may need adjustment
    const inputSelectors = [
      // ProseMirror-based selectors (most likely)
      'div[contenteditable="true"].ProseMirror',
      '.ProseMirror[contenteditable="true"]',
      '[data-testid="chat-input"]',
      'div[contenteditable="true"]:not([data-slate-zero-width])',
      // Fallback selectors
      'textarea[placeholder*="message" i]',
      'textarea[placeholder*="Ask" i]',
      'div[contenteditable="true"]',
      'textarea'
    ];

    let inputEl = null;
    for (const selector of inputSelectors) {
      inputEl = document.querySelector(selector);
      if (inputEl) {
        console.log('[AI Panel] Grok found input with selector:', selector);
        break;
      }
    }

    if (!inputEl) {
      throw new Error('Could not find input field');
    }

    // Focus the input
    inputEl.focus();

    // Handle different input types
    if (inputEl.tagName === 'TEXTAREA') {
      // Standard textarea
      inputEl.value = text;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (inputEl.classList.contains('ProseMirror') || inputEl.contentEditable === 'true') {
      // ProseMirror or contenteditable div
      inputEl.innerHTML = `<p>${escapeHtml(text)}</p>`;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // Generic fallback
      inputEl.textContent = text;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Small delay to let React process
    await sleep(100);

    // Find and click the send button
    const sendButton = findSendButton();
    if (!sendButton) {
      // Try pressing Enter as fallback (many chat UIs support this)
      console.log('[AI Panel] Grok send button not found, trying Enter key');
      inputEl.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true
      }));
    } else {
      // Wait for button to be enabled
      await waitForButtonEnabled(sendButton);
      sendButton.click();
    }

    // Start capturing response after sending
    console.log('[AI Panel] Grok message sent, starting response capture...');
    waitForStreamingComplete();

    return true;
  }

  function findSendButton() {
    // Grok's send button selectors (based on research)
    const selectors = [
      'button[aria-label="Send"]',
      'button[aria-label="Send message"]',
      'button[data-testid="send-button"]',
      'button[type="submit"]',
      'form button:last-of-type',
      'button svg[viewBox]' // Button containing an SVG arrow
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) {
        return el.closest('button') || el;
      }
    }

    // Fallback: find button near the input that has an SVG (likely send icon)
    const form = document.querySelector('form');
    if (form) {
      const buttons = form.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.querySelector('svg') && isVisible(btn)) {
          return btn;
        }
      }
    }

    // Another fallback: find visible button at bottom of page
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.querySelector('svg') && isVisible(btn)) {
        const rect = btn.getBoundingClientRect();
        if (rect.bottom > window.innerHeight - 200) {
          return btn;
        }
      }
    }

    return null;
  }

  async function waitForButtonEnabled(button, maxWait = 2000) {
    const start = Date.now();
    while (button.disabled && Date.now() - start < maxWait) {
      await sleep(50);
    }
  }

  function setupResponseObserver() {
    const observer = new MutationObserver((mutations) => {
      // Check context validity in observer callback
      if (!isContextValid()) {
        observer.disconnect();
        return;
      }
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              checkForResponse(node);
            }
          }
        }
      }
    });

    const startObserving = () => {
      if (!isContextValid()) return;
      const mainContent = document.querySelector('main') || document.body;
      observer.observe(mainContent, {
        childList: true,
        subtree: true
      });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startObserving);
    } else {
      startObserving();
    }
  }

  let lastCapturedContent = '';
  let isCapturing = false;

  function checkForResponse(node) {
    if (isCapturing) return;

    // Response container selectors (based on research)
    const responseSelectors = [
      '[data-testid*="response"]',
      '[data-testid*="message"]',
      '.message-response',
      '.ChatBubble',
      '[class*="assistant"]',
      '[class*="response"]',
      '[data-is-streaming]'
    ];

    for (const selector of responseSelectors) {
      if (node.matches?.(selector) || node.querySelector?.(selector)) {
        console.log('[AI Panel] Grok detected new response...');
        waitForStreamingComplete();
        break;
      }
    }
  }

  async function waitForStreamingComplete() {
    if (isCapturing) {
      console.log('[AI Panel] Grok already capturing, skipping...');
      return;
    }
    isCapturing = true;

    let previousContent = '';
    let stableCount = 0;
    const maxWait = 600000;  // 10 minutes - AI responses can be very long
    const checkInterval = 500;
    const stableThreshold = 4;  // 2 seconds of stable content

    const startTime = Date.now();

    try {
      while (Date.now() - startTime < maxWait) {
        if (!isContextValid()) {
          console.log('[AI Panel] Context invalidated, stopping capture');
          return;
        }

        await sleep(checkInterval);

        // Check for streaming indicators
        const isStreaming = document.querySelector('[data-is-streaming="true"]') ||
                           document.querySelector('button[aria-label*="Stop"]') ||
                           document.querySelector('[class*="loading"]') ||
                           document.querySelector('[class*="streaming"]');

        const currentContent = getLatestResponse() || '';

        if (!isStreaming && currentContent === previousContent && currentContent.length > 0) {
          stableCount++;
          if (stableCount >= stableThreshold) {
            if (currentContent !== lastCapturedContent) {
              lastCapturedContent = currentContent;
              safeSendMessage({
                type: 'RESPONSE_CAPTURED',
                aiType: AI_TYPE,
                content: currentContent
              });
              console.log('[AI Panel] Grok response captured, length:', currentContent.length);
            }
            return;
          }
        } else {
          stableCount = 0;
        }

        previousContent = currentContent;
      }
    } finally {
      isCapturing = false;
    }
  }

  function getLatestResponse() {
    // Response container selectors for Grok (based on research)
    // These may need adjustment after inspecting the actual DOM
    const messageSelectors = [
      // Likely selectors based on research
      '[data-testid*="response"] .markdown',
      '[data-testid*="message-content"]',
      '.message-response',
      '.ChatBubble:last-of-type',
      // Generic assistant/response selectors
      '[class*="assistant-message"]',
      '[class*="response-content"]',
      '[class*="model-response"]',
      // Fallback: any markdown content in conversation
      'main [class*="markdown"]',
      'main [class*="prose"]'
    ];

    let messages = [];
    for (const selector of messageSelectors) {
      messages = document.querySelectorAll(selector);
      if (messages.length > 0) {
        console.log('[AI Panel] Grok found response with selector:', selector);
        break;
      }
    }

    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      return lastMessage.innerText.trim();
    }

    return null;
  }

  // Utility functions
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    return style.display !== 'none' &&
           style.visibility !== 'hidden' &&
           style.opacity !== '0';
  }

  console.log('[AI Panel] Grok content script loaded');
})();
