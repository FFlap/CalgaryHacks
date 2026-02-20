import type { RewriteLevel, RuntimeRequest } from '@/lib/types';

const STYLE_ID = 'cred-selection-actions-style';
const ACTION_BAR_ID = 'cred-selection-actions';
const CARD_ID = 'cred-selection-result-card';
const UI_ATTR = 'data-cred-selection-ui';
const MIN_SELECTION_CHARS = 16;
const POINTER_ANCHOR_MAX_AGE_MS = 2_500;

const ext = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof browser;

type SelectionAction = 'simplify' | 'summarize';
type CardState = 'loading' | 'done' | 'error';

interface SelectionSnapshot {
  text: string;
  rect: DOMRect;
  anchorX: number;
  anchorY: number;
}

interface PointerAnchor {
  x: number;
  y: number;
  at: number;
}

interface ActionConfig {
  label: string;
  title: string;
  loadingText: string;
  emptyErrorText: string;
}

interface ActionResponse {
  ok: boolean;
  result?: string;
  error?: string;
}

const REWRITE_LEVELS: RewriteLevel[] = [1, 2, 3];
const LEVEL_LABELS: Record<RewriteLevel, string> = {
  1: 'L1',
  2: 'L2',
  3: 'L3',
};

const ACTION_CONFIG: Record<SelectionAction, ActionConfig> = {
  simplify: {
    label: 'Simplify',
    title: 'Plain-language version',
    loadingText: 'Simplifying selected text...',
    emptyErrorText: 'Could not simplify text. Make sure your API key is set in the extension popup.',
  },
  summarize: {
    label: 'Summarize',
    title: 'Concise summary',
    loadingText: 'Summarizing selected text...',
    emptyErrorText: 'Could not summarize text. Make sure your API key is set in the extension popup.',
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function installStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${ACTION_BAR_ID} {
      position: fixed;
      z-index: 2147483647;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border-radius: 999px;
      padding: 6px;
      background: #fff7ef;
      border: 1px solid #e8dbcf;
      box-shadow: 0 10px 22px rgba(24, 18, 13, 0.25);
      font-family: "DM Sans", system-ui, sans-serif;
    }
    #${ACTION_BAR_ID} .cred-action-btn {
      border: 0;
      border-radius: 999px;
      background: #af6d3a;
      color: #fff7ef;
      font: 600 12px/1 "DM Sans", system-ui, sans-serif;
      letter-spacing: 0.01em;
      padding: 9px 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    #${ACTION_BAR_ID} .cred-action-btn:hover {
      filter: brightness(1.06);
    }
    #${ACTION_BAR_ID} .cred-levels {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 0 2px;
    }
    #${ACTION_BAR_ID} .cred-level-btn {
      border: 1px solid #d9c7b5;
      border-radius: 999px;
      background: #fffdf9;
      color: #7a6a5b;
      font: 700 11px/1 "DM Sans", system-ui, sans-serif;
      padding: 7px 10px;
      cursor: pointer;
    }
    #${ACTION_BAR_ID} .cred-level-btn[data-active="true"] {
      background: #e8d7c6;
      border-color: #c9ac8d;
      color: #5f4935;
    }
    #${ACTION_BAR_ID} .cred-level-btn:hover {
      filter: brightness(0.98);
    }
    #${ACTION_BAR_ID} .cred-action-btn:focus-visible,
    #${ACTION_BAR_ID} .cred-level-btn:focus-visible,
    #${CARD_ID} .cred-selection-close:focus-visible {
      outline: 2px solid rgba(175, 109, 58, 0.6);
      outline-offset: 2px;
    }
    #${CARD_ID} {
      position: fixed;
      z-index: 2147483647;
      width: min(360px, calc(100vw - 16px));
      border-radius: 12px;
      border: 1px solid #e8dbcf;
      background: #fffcf8;
      color: #2d2520;
      box-shadow: 0 18px 34px rgba(24, 18, 13, 0.28);
      font-family: "DM Sans", system-ui, sans-serif;
      overflow: hidden;
    }
    #${CARD_ID} .cred-selection-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid #f0e2d5;
      background: #faf6f0;
    }
    #${CARD_ID} .cred-selection-title {
      font-size: 12px;
      font-weight: 700;
      color: #5c4f44;
    }
    #${CARD_ID} .cred-selection-close {
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: #6f5e4f;
      font-size: 16px;
      line-height: 1;
      width: 24px;
      height: 24px;
      cursor: pointer;
    }
    #${CARD_ID} .cred-selection-close:hover {
      background: rgba(175, 109, 58, 0.1);
    }
    #${CARD_ID} .cred-selection-body {
      margin: 0;
      padding: 12px;
      font-size: 13px;
      line-height: 1.45;
      color: #2d2520;
      white-space: pre-wrap;
    }
    #${CARD_ID}[data-state="loading"] .cred-selection-body {
      color: #7a6a5b;
      font-style: italic;
    }
    #${CARD_ID}[data-state="error"] .cred-selection-body {
      color: #a13f32;
    }
  `;
  document.documentElement.appendChild(style);
}

function isUiNode(node: Node | null): boolean {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  return Boolean(element?.closest(`[${UI_ATTR}="true"]`));
}

function getSelectionSnapshot(pointerAnchor: PointerAnchor | null): SelectionSnapshot | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  if (isUiNode(selection.anchorNode) || isUiNode(selection.focusNode)) return null;

  const rawText = selection.toString().replace(/\s+/g, ' ').trim();
  if (rawText.length < MIN_SELECTION_CHARS) return null;

  const range = selection.getRangeAt(0);
  if (!range || !range.getBoundingClientRect) return null;

  let rect = range.getBoundingClientRect();
  if ((rect.width <= 0 || rect.height <= 0) && range.getClientRects().length > 0) {
    rect = range.getClientRects()[0];
  }

  if (!Number.isFinite(rect.top) || !Number.isFinite(rect.left)) return null;
  if (rect.width <= 0 && rect.height <= 0) return null;

  const anchorElement = range.commonAncestorContainer instanceof Element
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  if (anchorElement?.closest('input,textarea,[contenteditable="true"]')) return null;

  const fallbackAnchorX = rect.left + rect.width / 2;
  const fallbackAnchorY = rect.bottom;
  const hasFreshPointerAnchor =
    pointerAnchor &&
    Date.now() - pointerAnchor.at <= POINTER_ANCHOR_MAX_AGE_MS &&
    Number.isFinite(pointerAnchor.x) &&
    Number.isFinite(pointerAnchor.y);

  return {
    text: rawText,
    rect,
    anchorX: hasFreshPointerAnchor ? pointerAnchor.x : fallbackAnchorX,
    anchorY: hasFreshPointerAnchor ? pointerAnchor.y : fallbackAnchorY,
  };
}

function setActionBarLevel(actionBar: HTMLElement, level: RewriteLevel) {
  const levelButtons = Array.from(actionBar.querySelectorAll<HTMLButtonElement>('[data-level]'));
  for (const button of levelButtons) {
    button.dataset.active = String(button.dataset.level === String(level));
  }
}

function createActionBar(
  initialLevel: RewriteLevel,
  onAction: (action: SelectionAction) => void,
  onLevelChange: (level: RewriteLevel) => void,
): HTMLElement {
  const root = document.createElement('div');
  root.id = ACTION_BAR_ID;
  root.setAttribute(UI_ATTR, 'true');
  root.innerHTML = `
    <button type="button" class="cred-action-btn" data-action="simplify">${ACTION_CONFIG.simplify.label}</button>
    <button type="button" class="cred-action-btn" data-action="summarize">${ACTION_CONFIG.summarize.label}</button>
    <div class="cred-levels" aria-label="Reading level">
      ${REWRITE_LEVELS.map((level) => `<button type="button" class="cred-level-btn" data-level="${level}">${LEVEL_LABELS[level]}</button>`).join('')}
    </div>
  `;
  setActionBarLevel(root, initialLevel);
  root.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  root.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const target = event.target as HTMLElement | null;
    const action = target?.closest('button')?.getAttribute('data-action');
    if (action === 'simplify' || action === 'summarize') {
      onAction(action);
      return;
    }
    const levelText = target?.closest('button')?.getAttribute('data-level');
    const level = Number(levelText);
    if (level === 1 || level === 2 || level === 3) {
      onLevelChange(level);
      setActionBarLevel(root, level);
    }
  });
  return root;
}

function createCard(onClose: () => void): HTMLElement {
  const card = document.createElement('section');
  card.id = CARD_ID;
  card.setAttribute('data-state', 'idle');
  card.setAttribute(UI_ATTR, 'true');
  card.innerHTML = `
    <div class="cred-selection-head">
      <span class="cred-selection-title"></span>
      <button type="button" class="cred-selection-close" aria-label="Close selection result">&times;</button>
    </div>
    <p class="cred-selection-body"></p>
  `;
  card.querySelector<HTMLButtonElement>('.cred-selection-close')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClose();
  });
  return card;
}

function positionNearSelection(element: HTMLElement, selection: SelectionSnapshot, gap = 10) {
  const margin = 8;
  const width = element.offsetWidth;
  const height = element.offsetHeight;

  const leftCandidate = selection.anchorX + gap;
  const leftFallback = selection.anchorX - width - gap;
  let left = leftCandidate;
  if (left + width > window.innerWidth - margin) {
    left = leftFallback;
  }
  left = clamp(left, margin, window.innerWidth - width - margin);

  const topCandidate = selection.anchorY + gap;
  const topFallback = selection.anchorY - height - gap;
  let top = topCandidate;
  if (top + height > window.innerHeight - margin) {
    top = topFallback;
  }
  top = clamp(top, margin, window.innerHeight - height - margin);

  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
}

async function sendActionRequest(
  action: SelectionAction,
  text: string,
  level: RewriteLevel,
): Promise<ActionResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const message: RuntimeRequest =
        action === 'simplify'
          ? { type: 'SIMPLIFY_TEXT', text, level }
          : { type: 'SUMMARIZE_TEXT', text, level };
      const response = (await ext.runtime.sendMessage(message)) as
        | { ok: boolean; simplified?: string; summary?: string; error?: string }
        | undefined;
      if (response) {
        return {
          ok: response.ok,
          result: action === 'simplify' ? response.simplified : response.summary,
          error: response.error,
        };
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 120 + attempt * 120));
  }
  const messageText = lastError instanceof Error ? lastError.message : 'Background request failed.';
  return { ok: false, error: messageText };
}

export default defineContentScript({
  matches: ['*://*/*'],
  main() {
    installStyles();

    let activeSelection: SelectionSnapshot | null = null;
    let actionBar: HTMLElement | null = null;
    let card: HTMLElement | null = null;
    let requestToken = 0;
    let selectedLevel: RewriteLevel = 2;
    let pointerSelectionInProgress = false;
    let lastPointerAnchor: PointerAnchor | null = null;

    const removeActionBar = () => {
      actionBar?.remove();
      actionBar = null;
    };

    const removeCard = () => {
      card?.remove();
      card = null;
    };

    const hideAllUi = () => {
      removeActionBar();
      removeCard();
      activeSelection = null;
      requestToken += 1;
      lastPointerAnchor = null;
    };

    const showCard = (
      state: CardState,
      action: SelectionAction,
      text: string,
      selection: SelectionSnapshot,
      level: RewriteLevel,
    ) => {
      if (!card) {
        card = createCard(() => {
          hideAllUi();
        });
        document.documentElement.appendChild(card);
      }
      card.dataset.state = state;
      const title = card.querySelector<HTMLElement>('.cred-selection-title');
      const body = card.querySelector<HTMLElement>('.cred-selection-body');
      if (title) {
        title.textContent = `${ACTION_CONFIG[action].title} • Level ${level}`;
      }
      if (body) {
        body.textContent = text;
      }
      positionNearSelection(card, selection);
    };

    const handleActionClick = async (action: SelectionAction) => {
      if (!activeSelection) return;
      const token = ++requestToken;
      const selected = activeSelection;
      const level = selectedLevel;
      removeActionBar();
      showCard('loading', action, ACTION_CONFIG[action].loadingText, selected, level);

      const response = await sendActionRequest(action, selected.text, level);
      if (token !== requestToken) return;

      if (!response.ok) {
        showCard('error', action, response.error ?? ACTION_CONFIG[action].emptyErrorText, selected, level);
        return;
      }

      showCard('done', action, response.result ?? selected.text, selected, level);
    };

    const showSelectionActions = (snapshot: SelectionSnapshot) => {
      if (!actionBar) {
        actionBar = createActionBar(
          selectedLevel,
          (action) => {
            void handleActionClick(action);
          },
          (level) => {
            selectedLevel = level;
          },
        );
        document.documentElement.appendChild(actionBar);
      }
      setActionBarLevel(actionBar, selectedLevel);
      activeSelection = snapshot;
      positionNearSelection(actionBar, snapshot);
    };

    const refreshSelectionUi = () => {
      const snapshot = getSelectionSnapshot(lastPointerAnchor);
      if (!snapshot) {
        removeActionBar();
        activeSelection = null;
        return;
      }
      removeCard();
      showSelectionActions(snapshot);
    };

    document.addEventListener(
      'selectionchange',
      () => {
        if (pointerSelectionInProgress) return;
        refreshSelectionUi();
      },
      true,
    );

    document.addEventListener(
      'mousedown',
      (event) => {
        if (isUiNode(event.target as Node | null)) return;
        pointerSelectionInProgress = true;
        lastPointerAnchor = null;
        removeCard();
      },
      true,
    );

    document.addEventListener(
      'mouseup',
      (event) => {
        if (isUiNode(event.target as Node | null)) return;
        pointerSelectionInProgress = false;
        lastPointerAnchor = {
          x: event.clientX,
          y: event.clientY,
          at: Date.now(),
        };
        window.setTimeout(refreshSelectionUi, 0);
      },
      true,
    );

    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') {
          hideAllUi();
        }
      },
      true,
    );

    window.addEventListener(
      'scroll',
      () => {
        hideAllUi();
      },
      true,
    );

    window.addEventListener('resize', hideAllUi);
  },
});
