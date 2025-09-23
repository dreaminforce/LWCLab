import { LightningElement, track } from 'lwc';

const CODE_STORAGE_KEY = 'lastCode';
const CHAT_STORAGE_KEY = 'chatMessages';

const DEFAULT_COMPONENT_NAME = 'PreviewComponent';
const DEFAULT_DEPLOY_TARGETS = ['lightning__AppPage', 'lightning__HomePage', 'lightning__RecordPage'];
const DEPLOY_TARGET_OPTIONS = [
  { label: 'App Page', value: 'lightning__AppPage', description: 'Expose on App Builder app pages' },
  { label: 'Home Page', value: 'lightning__HomePage', description: 'Expose on Lightning Home pages' },
  { label: 'Record Page', value: 'lightning__RecordPage', description: 'Expose on Lightning Record pages' },
];
const BUNDLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export default class Shell extends LightningElement {
  prompt = '';
  tab = 'preview';
  generating = false;
  hasGenerated = false;
  deploying = false;
  showDeployModal = false;
  deployUsername = '';
  deployPassword = '';
  deployError = '';
  deployBundleName = DEFAULT_COMPONENT_NAME;
  deployTargets = [...DEFAULT_DEPLOY_TARGETS];
  @track code = { html: '', js: '', css: '' };
  @track messages = [];

  get isPreview() { return this.tab === 'preview'; }
  get isCode() { return this.tab === 'code'; }
  get buttonLabel() { return this.generating ? 'Generating...' : 'Generate'; }
  get deployButtonLabel() { return this.deploying ? 'Deploying...' : 'Deploy to Salesforce'; }
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
  get isDeployDisabled() { return this.deploying || this.generating || !this.hasCode; }
  get deploySubmitDisabled() { return this.deploying || !this.canSubmitDeployment; }
  get hasMessages() { return this.messages.length > 0; }
  get hasCode() {
    return Boolean((this.code?.html || '').trim() || (this.code?.js || '').trim() || (this.code?.css || '').trim());
  }
  get deployTargetOptions() {
    return DEPLOY_TARGET_OPTIONS.map((option) => ({
      ...option,
      selected: this.deployTargets.includes(option.value),
    }));
  }

  get hasSelectedTargets() {
    return this.deployTargets.length > 0;
  }

  get isValidDeployName() {
    return BUNDLE_NAME_PATTERN.test((this.deployBundleName || '').trim());
  }

  get canSubmitDeployment() {
    return Boolean(
      this.deployUsername.trim() &&
      this.deployPassword &&
      this.isValidDeployName &&
      this.hasSelectedTargets
    );
  }
  get codeHtml() { return this.code?.html || ''; }
  get codeJs() { return this.code?.js || ''; }
  get codeCss() { return this.code?.css || ''; }

  decorateMessage(message) {
    if (!message || !message.role) {
      return null;
    }

    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const isUser = role === 'user';

    return {
      ...message,
      role,
      isUser,
      label: isUser ? 'You' : 'LWable',
      avatarLabel: isUser ? 'User avatar' : 'LWable avatar',
    };
  }

  formatConversation(messages) {
    if (!Array.isArray(messages)) {
      return [];
    }

    return messages
      .map((message) => {
        const role = message?.role === 'assistant' ? 'assistant' : 'user';
        const content = (message?.text ?? '').toString().trim();
        if (!content) {
          return null;
        }
        return { role, content };
      })
      .filter(Boolean);
  }

  getCodeSnippet(part) {
    switch (part) {
      case 'html':
        return this.codeHtml;
      case 'js':
        return this.codeJs;
      case 'css':
        return this.codeCss;
      default:
        return '';
    }
  }

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
    let restored = [];

    try {
      const raw = window.sessionStorage.getItem(CHAT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          restored = parsed
            .map((message) => this.decorateMessage(message))
            .filter(Boolean);
        }
      }
    } catch {
      restored = [];
    }

    this.messages = restored;
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

  copyCode = async (event) => {
    const button = event?.currentTarget;
    if (!button) {
      return;
    }

    const target = button.dataset?.target;
    const snippet = this.getCodeSnippet(target);

    if (!snippet) {
      return;
    }

    let copied = false;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(snippet);
        copied = true;
      }
    } catch {
      copied = false;
    }

    if (!copied) {
      const textarea = document.createElement('textarea');
      textarea.value = snippet;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.top = '-1000px';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
      } catch {
        // ignore copy failures
      }
      document.body.removeChild(textarea);
    }

    button.classList.add('code-view__copy--copied');
    window.clearTimeout(button._copyTimeout);
    button._copyTimeout = window.setTimeout(() => {
      button.classList.remove('code-view__copy--copied');
      button._copyTimeout = null;
    }, 1500);
  };

  resetDeployForm() {
    this.deployUsername = '';
    this.deployPassword = '';
    this.deployError = '';
    this.deployBundleName = DEFAULT_COMPONENT_NAME;
    this.deployTargets = [...DEFAULT_DEPLOY_TARGETS];
  }

  openDeployModal = () => {
    if (this.isDeployDisabled) {
      return;
    }

    this.resetDeployForm();
    this.showDeployModal = true;

    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        const input = this.template.querySelector('[data-field="bundle"]');
        if (input) {
          input.focus();
        }
      });
    }
  };

  closeDeployModal = () => {
    if (this.deploying) {
      return;
    }
    this.showDeployModal = false;
    this.resetDeployForm();
  };

  handleDeployBackdropClick = () => {
    this.closeDeployModal();
  };

  handleDeployInput = (event) => {
    const field = event.target?.dataset?.field;
    const value = event.target?.value ?? '';
    if (field === 'username') {
      this.deployUsername = value;
    } else if (field === 'password') {
      this.deployPassword = value;
    } else if (field === 'bundle') {
      this.deployBundleName = value;
    }
    this.deployError = '';
  };

  toggleDeployTarget = (event) => {
    const value = event?.target?.value;
    const isChecked = Boolean(event?.target?.checked);
    if (!value) {
      return;
    }

    if (isChecked) {
      if (!this.deployTargets.includes(value)) {
        this.deployTargets = [...this.deployTargets, value];
      }
    } else {
      this.deployTargets = this.deployTargets.filter((target) => target !== value);
    }

    this.deployError = '';
  };

  submitDeployment = async (event) => {
    event?.preventDefault?.();
    if (this.deploying) {
      return;
    }

    const username = this.deployUsername.trim();
    const password = this.deployPassword;
    const bundleName = (this.deployBundleName || '').trim();
    const targets = Array.from(new Set(this.deployTargets));

    if (!username || !password) {
      this.deployError = 'Username and password are required.';
      return;
    }

    if (!BUNDLE_NAME_PATTERN.test(bundleName)) {
      this.deployError = 'Component name must start with a letter and can contain only letters, numbers, or underscores.';
      return;
    }

    if (targets.length === 0) {
      this.deployError = 'Select at least one target for the component.';
      return;
    }

    this.deployError = '';
    this.deploying = true;

    try {
      const response = await fetch('http://localhost:3001/api/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, bundleName, targets }),
      });

      let data;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (!response.ok || !data?.ok) {
        const message = data?.error || 'Deployment failed.';
        this.deployError = message;
        return;
      }

      const status = (data?.status || 'Succeeded').toLowerCase();
      const component = data?.component || bundleName;

      this.deploying = false;
      this.closeDeployModal();
      // eslint-disable-next-line no-alert
      alert(`Deployment ${status} for ${component}.`);
    } catch {
      this.deployError = 'Deployment failed. Check API server logs.';
    } finally {
      this.deploying = false;
    }
  };

  clearPromptInput() {
    this.prompt = '';
    const textarea = this.template.querySelector('[data-element-id="prompt-input"]');
    if (textarea) {
      textarea.value = '';
    }
  }

  createMessage(role, text) {
    const base = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      role,
      label: role === 'user' ? 'You' : 'LWable',
      text,
    };

    return this.decorateMessage(base) ?? base;
  }

  async generate() {
    const trimmedPrompt = this.prompt.trim();
    if (!trimmedPrompt) {
      return;
    }

    this.clearPromptInput();
    this.generating = true;

    const userMessage = this.createMessage('user', trimmedPrompt);
    const pendingMessages = [...this.messages, userMessage];
    this.messages = pendingMessages;
    this.persistMessages(pendingMessages);

    try {
      const base = (this.code.html || this.code.js || this.code.css) ? this.code : null;

      const conversation = this.formatConversation(pendingMessages);

      const response = await fetch('http://localhost:3001/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: trimmedPrompt, base, conversation }),
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

      this.clearPromptInput();
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


