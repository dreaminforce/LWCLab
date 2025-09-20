import { LightningElement, track } from 'lwc';

const CODE_STORAGE_KEY = 'lastCode';
const CHAT_STORAGE_KEY = 'chatMessages';

export default class Shell extends LightningElement {
  prompt = '';
  tab = 'preview';
  generating = false;
  hasGenerated = false;
  @track code = { html: '', js: '', css: '' };
  @track messages = [];

  get isPreview() { return this.tab === 'preview'; }
  get isCode() { return this.tab === 'code'; }
  get buttonLabel() { return this.generating ? 'Generating...' : 'Generate'; }
  get previewBtnClass() {
    return this.isPreview
      ? 'view-toggle__button view-toggle__button--active'
      : 'view-toggle__button';
  }
  get codeBtnClass() {
    return this.isCode
      ? 'view-toggle__button view-toggle__button--active'
      : 'view-toggle__button';
  }
  get isGenerateDisabled() { return this.generating || !this.prompt.trim(); }
  get hasMessages() { return this.messages.length > 0; }
  get hasCode() {
    return Boolean((this.code?.html || '').trim() || (this.code?.js || '').trim() || (this.code?.css || '').trim());
  }
  get codeHtml() { return this.code?.html || ''; }
  get codeJs() { return this.code?.js || ''; }
  get codeCss() { return this.code?.css || ''; }

  connectedCallback() {
    const shouldShowPreview = window.location.hash === '#show';

    if (shouldShowPreview) {
      this.restoreMessages();
      this.hasGenerated = true;
      this.restoreCode();
      this.clearHash();
      return;
    }

    window.sessionStorage.removeItem(CHAT_STORAGE_KEY);
    this.messages = [];

    fetch('http://localhost:3001/api/reset', { method: 'POST' }).catch(() => {});
    window.sessionStorage.removeItem(CODE_STORAGE_KEY);
    this.hasGenerated = false;
    this.code = { html: '', js: '', css: '' };
  }

  restoreCode() {
    try {
      const raw = window.sessionStorage.getItem(CODE_STORAGE_KEY);
      if (raw) {
        this.code = JSON.parse(raw);
      }
    } catch {
      this.code = { html: '', js: '', css: '' };
    }
  }

  restoreMessages() {
    try {
      const raw = window.sessionStorage.getItem(CHAT_STORAGE_KEY);
      if (raw) {
        this.messages = JSON.parse(raw);
      }
    } catch {
      this.messages = [];
    }
  }

  persistMessages(nextMessages) {
    try {
      window.sessionStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(nextMessages));
    } catch {
      // ignore storage errors
    }
  }

  clearHash() {
    try {
      window.history.replaceState(null, '', window.location.pathname);
    } catch {
      // ignore history errors
    }
  }

  handleInput = (event) => {
    this.prompt = event.target.value;
  };

  setTab = (event) => {
    this.tab = event.currentTarget.dataset.tab;
  };

  createMessage(role, text) {
    return {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      role,
      label: role === 'user' ? 'You' : 'Assistant',
      text,
    };
  }

  async generate() {
    const trimmedPrompt = this.prompt.trim();
    if (!trimmedPrompt) {
      return;
    }

    this.generating = true;

    const userMessage = this.createMessage('user', trimmedPrompt);
    const pendingMessages = [...this.messages, userMessage];
    this.messages = pendingMessages;
    this.persistMessages(pendingMessages);

    try {
      const base = (this.code.html || this.code.js || this.code.css) ? this.code : null;

      const response = await fetch('http://localhost:3001/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: trimmedPrompt, base }),
      });

      if (!response.ok) {
        throw new Error('API error');
      }

      const data = await response.json();
      this.code = data.code ?? { html: '', js: '', css: '' };

      try {
        window.sessionStorage.setItem(CODE_STORAGE_KEY, JSON.stringify(this.code));
      } catch {
        // ignore storage errors
      }

      const assistantMessage = this.createMessage(
        'assistant',
        'Component updated. Use the preview and code panels to review the output.'
      );
      const confirmedMessages = [...pendingMessages, assistantMessage];
      this.messages = confirmedMessages;
      this.persistMessages(confirmedMessages);

      this.prompt = '';
      window.location.hash = '#show';
      window.location.reload();
    } catch (error) {
      const failureMessage = this.createMessage(
        'assistant',
        'Something went wrong while generating. Please try again.'
      );
      const failedMessages = [...pendingMessages, failureMessage];
      this.messages = failedMessages;
      this.persistMessages(failedMessages);

      // eslint-disable-next-line no-alert
      alert('Generation failed. Check API server logs.');
    } finally {
      this.generating = false;
    }
  }
}