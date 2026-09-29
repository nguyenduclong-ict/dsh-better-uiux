/**
 * dsh-better-uiux — browser half.
 *
 * Responsibilities:
 *  1. Own the durable feature config (three switches + the CSS snippet) behind
 *     `/api/better-uiux/config`, mirrored in `localStorage` so state is right
 *     before the host answers.
 *  2. Contribute the "Better UIUX" row to the Settings modal nav, holding every
 *     switch and the CSS editor.
 *  3. Inject the user's snippet into `document.head` while custom CSS is on.
 *  4. Edit a message that is already in the transcript and re-run the
 *     conversation from that point (see the long note above `editMessage`).
 *     TEMPORARILY HIDDEN: the code is here and tested, the feature is closed —
 *     see `EDIT_MESSAGE_HIDDEN` below.
 *
 * The live-terminal half is a SEPARATE module registered by `live-terminal.js`;
 * this file publishes the shared config/API object on `globalThis` so that half
 * can read the switches without knowing about this module's load order.
 */

window.__ModuleLoader__.load({
  id: 'dsh-better-uiux',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const jsxRuntime = require('react/jsx-runtime');
    const jsx = jsxRuntime.jsx;
    const jsxs = jsxRuntime.jsxs;

    /** Locale dictionary namespace owned by this plugin. */
    const NS = 'better-uiux';
    /** Kept in step with package.json: names the running build in the console. */
    const CLIENT_VERSION = '0.1.1';
    /** Slot key of the Settings nav row this plugin fills. */
    const SECTION_SLOT = 'settings.section';
    /** id of the injected `<style>` element; also the head-order guard selector. */
    const STYLE_ID = 'dsh-better-uiux-style';
    /** localStorage mirror key (hot path: applied before the host answers). */
    const CACHE_KEY = 'dsh_better_uiux_config_v2';
    /** Debounce before a keystroke is sent to the host. */
    const SAVE_DEBOUNCE_MS = 500;
    /** Global hand-off object for the live-terminal half. */
    const GLOBAL_KEY = '__DSH_BETTER_UIUX__';

    /**
     * TEMPORARILY HIDDEN — Edit message.
     *
     * The implementation (button injection, fork + resend, the draft modal, its
     * dictionaries) is still in this bundle and still covered by the test suite,
     * but the feature is closed at every entry point: no switch is rendered, no
     * note explains it, `editMessage` is not a FEATURE_KEY so it cannot be toggled,
     * and `syncFeatures()` never starts the editor even when a stale cached config
     * says it is on. The host half clamps the flag to `false` as well, so it cannot
     * be switched on from outside these two files.
     *
     * Flip this single constant to `false` to bring the feature back: that restores
     * the third switch, the note, and `'editMessage'` in FEATURE_KEYS below.
     */
    const EDIT_MESSAGE_HIDDEN = true;

    /** Feature keys, in the order they render. */
    const FEATURE_KEYS = EDIT_MESSAGE_HIDDEN
      ? ['liveTerminal', 'customCss']
      : ['liveTerminal', 'customCss', 'editMessage'];

    // ---------------------------------------------------------------------
    // Dictionaries
    // ---------------------------------------------------------------------

    const zh = {
      nav: 'Better UIUX',
      heading: 'Better UIUX',
      intro: 'Harness 界面增强功能。每项都可以独立开关，关闭后完全停止工作。',
      featuresHeading: '功能开关',
      liveTerminalLabel: '实时终端输出',
      liveTerminalHint: '把命令和后台任务的输出实时显示在对话里。DSH 将来会自带该功能，届时可以在这里关闭。',
      customCssLabel: '自定义 CSS',
      customCssHint: '注入你自己的样式来调整 Harness 界面的外观。',
      editMessageLabel: '编辑消息',
      editMessageHint: '给已发送的消息加上「编辑」按钮：改写后用 fork + 重新发送在该处重跑对话。',
      noteHeading: '说明',
      editNoteTitle: '编辑消息会新建一个会话',
      editNoteBody: 'DSH 的会话记录是只追加的事件日志，无法就地改写已发出的消息。因此「编辑并重发」会在目标消息之前切出一个新的分支会话（原会话保留不变），然后在新会话里发送你改写后的内容。',
      editorTitle: 'CSS 代码',
      editorHint: '输入时即时注入；内容会自动保存。',
      editorPlaceholder: '/* 示例 */\n:root { --dsw-alias-brand-primary: #22d3ee; }',
      stateOn: '已启用',
      stateOff: '已关闭',
      saving: '保存中…',
      saved: '已保存',
      paused: '已保存代码，但注入已关闭',
      saveError: '无法保存到主机，本次仅在本机浏览器生效',
      loadError: '无法从主机读取已保存的设置',
      external: '由其他来源注入的样式不会被移除。',
      enabledCount: '{on}/{total} 已启用',
      editAction: '编辑',
      editTitle: '编辑消息',
      editHint: '保存后会从这条消息处重新开始：新会话保留它之前的全部上下文。',
      editSave: '保存并重发',
      editSaveHint: '在新分支会话中重发',
      editRetire: '删除旧会话（放弃这条消息之后的所有回合）',
      editRetireHint: '分支创建后删除原会话。这是让第 4、5 回合消失的方式——它们无法被单独删除。',
      editSentRetired: '已在新会话中重发，并删除了旧会话',
      editSentKeptOld: '已在新会话中重发（旧会话仍保留）',
      editRetireFailed: '分支已创建，但无法删除旧会话',
      editComposer: '填入输入框',
      editComposerHint: '把内容放进底部输入框，这样可以用 @ 提及文件、/ 命令、附件等全部功能',
      editComposerFilled: '已填入输入框 — 按发送即可',
      editComposerUnavailable: '输入框当前不可用',
      editComposerNote: '注意：在输入框里发送会作为新消息追加到当前会话，不会从这条消息处重跑。',
      editCancel: '取消',
      editBusy: '正在创建分支会话…',
      editSent: '已在新会话中重发',
      editFailed: '无法创建分支，未改动任何内容。如需追加为普通消息，请使用「填入输入框」。',
      editEmpty: '内容不能为空。',
      editUnavailable: '这一轮尚未结束，暂时不能编辑。'
    };

    const en = {
      nav: 'Better UIUX',
      heading: 'Better UIUX',
      intro: 'Interface enhancements for the Harness. Each one can be switched off independently — a disabled feature stops working entirely.',
      featuresHeading: 'Features',
      liveTerminalLabel: 'Live terminal output',
      liveTerminalHint: 'Stream command and background-job output into the conversation as it runs. DSH is expected to ship this natively — turn this off then.',
      customCssLabel: 'Custom CSS',
      customCssHint: 'Inject your own styles to restyle the Harness interface.',
      editMessageLabel: 'Edit message',
      editMessageHint: 'Adds an Edit button to messages already sent: rewrite one and re-run the conversation from that point.',
      noteHeading: 'Notes',
      editNoteTitle: 'Editing a message creates a new session',
      editNoteBody: 'A DSH transcript is an append-only event log, so a sent message cannot be rewritten in place. "Edit and resend" therefore cuts a new branch session just before the target message (the original session is left untouched) and sends your rewritten text there.',
      editorTitle: 'CSS code',
      editorHint: 'Injected live as you type; saved automatically.',
      editorPlaceholder: '/* example */\n:root { --dsw-alias-brand-primary: #22d3ee; }',
      stateOn: 'Enabled',
      stateOff: 'Disabled',
      saving: 'Saving…',
      saved: 'Saved',
      paused: 'Code saved, but injection is off',
      saveError: 'Could not save to the host — applied in this browser only',
      loadError: 'Could not load the saved settings from the host',
      external: 'Styles injected by other sources are never removed.',
      enabledCount: '{on}/{total} enabled',
      editAction: 'Edit',
      editTitle: 'Edit message',
      editHint: 'Saving restarts from this message: the new session keeps everything before it.',
      editSave: 'Save & resend',
      editSaveHint: 'Resend in a new branch session',
      editRetire: 'Delete the old session (drops every turn after this message)',
      editRetireHint: 'After the branch is created, delete the source session. That is what makes turns 4 and 5 disappear — they cannot be deleted individually.',
      editSentRetired: 'Resent in a new session, and the old one was deleted',
      editSentKeptOld: 'Resent in a new session (the old one is kept)',
      editRetireFailed: 'Branch created, but the old session could not be deleted',
      editComposer: 'Fill into composer',
      editComposerHint: 'Put this text in the real composer, so you get @-mentions, / commands, attachments and the rest',
      editComposerFilled: 'Filled into the composer — press send when ready',
      editComposerUnavailable: 'The composer is not available right now',
      editComposerNote: 'Note: sending from the composer appends a NEW message to this session; it does not re-run from this point.',
      editCancel: 'Cancel',
      editBusy: 'Creating the branch session…',
      editSent: 'Resent in a new session',
      editFailed: 'Could not branch, so nothing was changed. Use "Fill into composer" if you want it as a normal message instead.',
      editEmpty: 'The message cannot be empty.',
      editUnavailable: 'This turn has not finished yet, so it cannot be edited.'
    };

    const vi = {
      nav: 'Better UIUX',
      heading: 'Better UIUX',
      intro: 'Các tính năng tăng cường giao diện Harness. Mỗi tính năng bật/tắt độc lập — tắt là dừng hoạt động hoàn toàn.',
      featuresHeading: 'Tính năng',
      liveTerminalLabel: 'Live terminal output',
      liveTerminalHint: 'Hiển thị output của lệnh và job nền ngay trong hội thoại. DSH sẽ sớm có tính năng này — khi đó hãy tắt ở đây.',
      customCssLabel: 'Custom CSS',
      customCssHint: 'Inject CSS của bạn để tùy biến giao diện Harness.',
      editMessageLabel: 'Edit message',
      editMessageHint: 'Thêm nút Sửa cho tin nhắn đã gửi: viết lại rồi chạy lại hội thoại từ đúng chỗ đó.',
      noteHeading: 'Ghi chú',
      editNoteTitle: 'Sửa tin nhắn sẽ tạo một session mới',
      editNoteBody: 'Transcript của DSH là log chỉ ghi thêm, nên không thể sửa tại chỗ một tin nhắn đã gửi. Vì vậy "Sửa và gửi lại" sẽ cắt một session nhánh mới ngay trước tin nhắn đó (session gốc giữ nguyên) rồi gửi nội dung bạn viết lại vào đó.',
      editorTitle: 'Mã CSS',
      editorHint: 'Được inject ngay khi bạn nhập; tự động lưu.',
      editorPlaceholder: '/* ví dụ */\n:root { --dsw-alias-brand-primary: #22d3ee; }',
      stateOn: 'Đang bật',
      stateOff: 'Đang tắt',
      saving: 'Đang lưu…',
      saved: 'Đã lưu',
      paused: 'Đã lưu CSS nhưng đang tắt inject',
      saveError: 'Không lưu được lên host — chỉ áp dụng trong trình duyệt này',
      loadError: 'Không đọc được cấu hình đã lưu từ host',
      external: 'Style do nguồn khác inject sẽ không bị gỡ bỏ.',
      enabledCount: '{on}/{total} đang bật',
      editAction: 'Sửa',
      editTitle: 'Sửa tin nhắn',
      editHint: 'Lưu sẽ chạy lại từ tin nhắn này: session mới giữ toàn bộ ngữ cảnh phía trước.',
      editSave: 'Lưu & gửi lại',
      editSaveHint: 'Gửi lại trong một session nhánh mới',
      editRetire: 'Xoá session cũ (bỏ mọi lượt sau tin nhắn này)',
      editRetireHint: 'Sau khi tạo nhánh, xoá session gốc. Đây chính là thứ làm lượt 4 và 5 biến mất — không xoá riêng lẻ được.',
      editSentRetired: 'Đã gửi lại trong session mới và xoá session cũ',
      editSentKeptOld: 'Đã gửi lại trong session mới (giữ lại session cũ)',
      editRetireFailed: 'Đã tạo nhánh nhưng không xoá được session cũ',
      editComposer: 'Điền vào ô nhập',
      editComposerHint: 'Đưa nội dung xuống ô nhập thật, để dùng được @ mention file, / command, tệp đính kèm…',
      editComposerFilled: 'Đã điền vào ô nhập — bấm gửi khi xong',
      editComposerUnavailable: 'Ô nhập hiện không dùng được',
      editComposerNote: 'Lưu ý: gửi từ ô nhập sẽ THÊM một tin nhắn mới vào session này, không chạy lại từ chỗ này.',
      editCancel: 'Hủy',
      editBusy: 'Đang tạo session nhánh…',
      editSent: 'Đã gửi lại trong session mới',
      editFailed: 'Không tạo được nhánh nên không thay đổi gì. Muốn gửi như tin nhắn thường thì dùng "Điền vào ô nhập".',
      editEmpty: 'Nội dung không được để trống.',
      editUnavailable: 'Lượt này chưa kết thúc nên chưa sửa được.'
    };

    // ---------------------------------------------------------------------
    // Config state
    // ---------------------------------------------------------------------

    /**
     * Shipped defaults — separate from the host half's, which mirrors these.
     *
     * `editMessage` is OFF by default on purpose. Editing a message cannot rewrite
     * it in place, so the feature necessarily branches the session; until that
     * behaviour is settled, edit stays opt-in rather than surprising anyone who
     * never asked for it. Turn it on in Settings → Better UIUX.
     */
    const DEFAULT_FEATURES = Object.freeze({
      liveTerminal: true,
      customCss: true,
      editMessage: false
    });

    /** Live config: the single source of truth for every feature in this plugin. */
    let config = { features: { ...DEFAULT_FEATURES }, css: '' };
    const listeners = new Set();
    let hydrated = false;
    let loadError = null;
    let saveState = 'idle';
    let saveTimer = null;

    function notify() {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          console.warn('[better-uiux] listener failed:', error);
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    /** React binding over the module store (this bundle ships no store package). */
    function useConfig() {
      const [, force] = React.useReducer((n) => n + 1, 0);
      React.useEffect(() => subscribe(force), []);
      return { config, saveState, loadError };
    }

    /** Normalize anything that claims to be a config document. */
    function normalize(value) {
      const source = value !== null && typeof value === 'object' ? value : {};
      const features = source.features !== null && typeof source.features === 'object' ? source.features : {};
      return {
        // Mirrors the host: an absent flag means the shipped default (on).
        features: {
          liveTerminal: typeof features.liveTerminal === 'boolean' ? features.liveTerminal : DEFAULT_FEATURES.liveTerminal,
          customCss: typeof features.customCss === 'boolean' ? features.customCss : DEFAULT_FEATURES.customCss,
          editMessage: typeof features.editMessage === 'boolean' ? features.editMessage : DEFAULT_FEATURES.editMessage
        },
        css: typeof source.css === 'string' ? source.css : ''
      };
    }

    function readCache() {
      try {
        const raw = window.localStorage.getItem(CACHE_KEY);
        if (raw === null) return null;
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object') return null;
        return normalize(parsed);
      } catch {
        return null;
      }
    }

    function writeCache() {
      try {
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(config));
      } catch {
        /* private mode / quota — the host remains the durable copy */
      }
    }

    // ---------------------------------------------------------------------
    // Style injection (custom CSS feature)
    // ---------------------------------------------------------------------

    function ensureStyleElement() {
      let tag = document.getElementById(STYLE_ID);
      if (tag === null) {
        tag = document.createElement('style');
        tag.id = STYLE_ID;
        tag.dataset.plugin = 'dsh-better-uiux';
        document.head.appendChild(tag);
      } else if (tag.parentElement !== document.head) {
        document.head.appendChild(tag);
      }
      return tag;
    }

    /**
     * Reflect `config.css` into the injected style tag. The tag is re-appended to
     * `<head>` on every write so a boot-time plugin that appends its own
     * stylesheet later still loses the cascade to the user's snippet.
     */
    function applyCustomCss() {
      const css = config.css;
      const shouldInject = config.features.customCss && css.trim().length > 0;
      const existing = document.getElementById(STYLE_ID);
      if (!shouldInject) {
        if (existing !== null) existing.textContent = '';
        return;
      }
      const tag = ensureStyleElement();
      if (tag.textContent !== css) tag.textContent = css;
      if (tag !== document.head.lastElementChild) document.head.appendChild(tag);
    }

    // ---------------------------------------------------------------------
    // Host persistence
    // ---------------------------------------------------------------------

    /**
     * Read the config the host holds, then activate every feature from whatever
     * the final config is.
     *
     * The activation in `finally` must NOT be conditional on the config having
     * CHANGED. On a reload the cached config and the host answer are identical,
     * so a "only if changed" guard skips the entire startup path and nothing is
     * ever started — the Edit button then only appeared after the user touched a
     * switch, because that path runs `commit()`. `syncFeatures` is idempotent, so
     * calling it here unconditionally is safe and is the whole point.
     */
    async function loadFromHost() {
      try {
        const response = await fetch('/api/better-uiux/config', {
          headers: { Accept: 'application/json' },
          cache: 'no-store'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        config = normalize(data);
        loadError = null;
        writeCache();
        notify();
      } catch (error) {
        // Keep whatever the cache provided (or the shipped defaults) and still
        // activate: a host hiccup must not leave every feature dead.
        loadError = error?.message ?? String(error);
        console.warn('[better-uiux] Failed to load config from host:', error);
        notify();
      } finally {
        hydrated = true;
        try {
          syncFeatures();
        } catch (error) {
          console.warn('[better-uiux] feature activation failed:', error);
        }
      }
    }

    async function saveToHost() {
      saveState = 'saving';
      notify();
      try {
        const response = await fetch('/api/better-uiux/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ features: config.features, css: config.css })
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        saveState = 'saved';
        loadError = null;
      } catch (error) {
        saveState = 'error';
        console.warn('[better-uiux] Failed to save config to host:', error);
      }
      notify();
    }

    function scheduleSave() {
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        saveTimer = null;
        void saveToHost();
      }, SAVE_DEBOUNCE_MS);
    }

    function flushSave() {
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
        saveTimer = null;
      }
      void saveToHost();
    }

    /** Apply immediately + persist in the background (used by every gesture). */
    function commit(patch) {
      config = normalize({ ...config, ...patch });
      writeCache();
      syncFeatures();
      notify();
      scheduleSave();
    }

    /** Toggle one feature flag. */
    function setFeature(key, on) {
      if (!FEATURE_KEYS.includes(key)) return;
      commit({ features: { ...config.features, [key]: on === true } });
    }

    // ---------------------------------------------------------------------
    // Feature lifecycle
    // ---------------------------------------------------------------------

    /**
     * Subscribers that want the raw feature flags on every change.
     *
     * Declared before the functions that read it, so the module-scope
     * `loadFromHost()` at the bottom of this module can never reach it while it
     * is still in its temporal dead zone.
     */
    const featureSyncListeners = new Set();

    /**
     * Apply the current config to every feature.
     *
     * Called once after the first host answer (see `loadFromHost`) and on every
     * config change. It must NOT be gated on "the config changed": on a reload the
     * cached config and the host config are identical, and a change-gated call
     * skips the whole startup path — nothing is ever started, and the message
     * editor would only appear after the user touched a switch (which runs
     * `commit()`). Both `startMessageEditor` and the live-terminal side are
     * idempotent, so calling this again is free.
     */
    function syncFeatures() {
      applyCustomCss();

      const listeners = featureSyncListeners;
      for (const listener of [...listeners]) {
        try {
          listener(config.features);
        } catch (error) {
          console.warn('[better-uiux] feature listener failed:', error);
        }
      }

      // `EDIT_MESSAGE_HIDDEN` is checked first: while the feature is hidden the
      // editor is never started, whatever the config (cache included) claims.
      if (!EDIT_MESSAGE_HIDDEN && config.features.editMessage === true) {
        editorFeatureWanted = true;
        startMessageEditor();
      } else {
        editorFeatureWanted = false;
        stopMessageEditor();
      }
    }
    // ---------------------------------------------------------------------
    // Styles for this plugin's own chrome
    // ---------------------------------------------------------------------

    const CHROME_STYLE_ID = 'dsh-better-uiux-chrome-style';
    const CHROME_STYLE_VERSION = '2';

    function ensureChromeStyles() {
      const existing = document.getElementById(CHROME_STYLE_ID);
      if (existing && existing.dataset.version === CHROME_STYLE_VERSION) return;
      if (existing) existing.remove();

      const tag = document.createElement('style');
      tag.id = CHROME_STYLE_ID;
      tag.dataset.version = CHROME_STYLE_VERSION;
      tag.dataset.plugin = 'dsh-better-uiux';
      tag.textContent = `
        .dsh-bu-section {
          display: flex;
          flex-direction: column;
          gap: 14px;
          max-width: 780px;
          color: var(--dsw-alias-label-primary);
        }
        .dsh-bu-heading {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
          line-height: 1.4;
        }
        .dsh-bu-intro {
          margin: 0;
          color: var(--dsw-alias-label-tertiary);
          font-size: 13px;
          line-height: 1.55;
        }
        .dsh-bu-group-title {
          margin: 2px 0 0;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.02em;
          text-transform: uppercase;
          color: var(--dsw-alias-label-tertiary);
        }
        .dsh-bu-card {
          border: 0.5px solid var(--dsw-alias-border-l4);
          background: var(--dsw-alias-bg-layer-3);
          border-radius: 16px;
          padding: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .dsh-bu-row {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          padding: 14px 16px;
        }
        .dsh-bu-row + .dsh-bu-row {
          border-top: 0.5px solid var(--dsw-alias-border-l4);
        }
        .dsh-bu-row-text {
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-width: 0;
          flex: 1;
        }
        .dsh-bu-row-title {
          font-size: 14px;
          font-weight: 500;
          line-height: 1.5;
        }
        .dsh-bu-hint {
          margin: 0;
          color: var(--dsw-alias-label-tertiary);
          font-size: 12px;
          line-height: 1.55;
        }
        .dsh-bu-controls {
          display: flex;
          align-items: center;
          gap: 10px;
          flex: none;
        }
        .dsh-bu-switch {
          box-sizing: border-box;
          position: relative;
          flex: none;
          width: 40px;
          height: 22px;
          padding: 2px;
          border: 0;
          border-radius: 11px;
          background: var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.22));
          cursor: pointer;
          transition: background 0.16s ease;
        }
        .dsh-bu-switch[data-on="true"] {
          background: var(--dsw-alias-brand-primary, #3b82f6);
        }
        .dsh-bu-switch:focus-visible {
          outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6);
          outline-offset: 2px;
        }
        .dsh-bu-thumb {
          display: block;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: var(--dsw-alias-label-primary-foreground, #ffffff);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
          transition: transform 0.14s ease;
        }
        .dsh-bu-switch[data-on="true"] .dsh-bu-thumb {
          transform: translate(18px);
        }
        .dsh-bu-status {
          flex: none;
          white-space: nowrap;
          border-radius: 999px;
          padding: 2px 8px;
          font-size: 11px;
          font-weight: 500;
          line-height: 17px;
          background: var(--dsw-alias-bg-module-platform, rgba(255, 255, 255, 0.08));
          color: var(--dsw-alias-label-secondary);
        }
        .dsh-bu-status[data-on="true"] {
          color: var(--dsw-alias-state-business-primary, #60a5fa);
        }
        .dsh-bu-editor-block {
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 14px 16px;
          border-top: 0.5px solid var(--dsw-alias-border-l4);
        }
        .dsh-bu-editor-head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
        }
        .dsh-bu-editor-label {
          font-size: 13px;
          font-weight: 500;
          line-height: 1.5;
        }
        .dsh-bu-editor {
          box-sizing: border-box;
          width: 100%;
          min-height: 240px;
          resize: vertical;
          padding: 12px;
          border: 0.5px solid var(--dsw-alias-border-l4);
          border-radius: 12px;
          background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.25));
          color: var(--dsw-alias-label-primary);
          font-family: var(--dsw-font-markdown-code-block, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
          font-size: 12.5px;
          line-height: 1.6;
          tab-size: 2;
          outline: none;
          transition: border-color 0.16s ease;
        }
        .dsh-bu-editor:focus-visible {
          border-color: var(--dsw-alias-brand-primary, #3b82f6);
        }
        .dsh-bu-editor::placeholder {
          color: var(--dsw-alias-label-tertiary);
        }
        .dsh-bu-foot {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
        }
        .dsh-bu-error {
          margin: 0;
          color: var(--dsw-alias-label-error, #f87171);
          font-size: 12px;
          line-height: 1.5;
        }
        .dsh-bu-count {
          color: var(--dsw-alias-label-tertiary);
          font-size: 12px;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
        .dsh-bu-note {
          border: 0.5px solid var(--dsw-alias-border-l4);
          border-radius: 16px;
          padding: 14px 16px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          background: var(--dsw-alias-bg-layer-3);
        }
        .dsh-bu-note-title {
          font-size: 13px;
          font-weight: 600;
          line-height: 1.5;
        }
        /* ---- message edit affordance ---- */
        /* Sized to match the shell's own icon row (its wrapper is
           height:calc(28px + delta), align-items:center, gap:8px, and every icon
           in it is 16x16). The button is inline-flex with no padding so it takes
           a 16px box in that row, exactly like the copy button's icon beside it.
           NOTE: never put a backtick in this stylesheet - the whole block is a
           template literal, so one stray backtick ends it. */
        .dsh-bu-edit-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex: none;
          width: 16px;
          height: 16px;
          padding: 0;
          margin: 0;
          border: 0;
          border-radius: 4px;
          background: transparent;
          color: var(--dsw-alias-label-tertiary);
          cursor: pointer;
          opacity: 1;
          transition: color 0.14s ease;
        }
        /* ALWAYS visible, by request.
           Fading the button alone is not enough: the shell fades the WHOLE action
           row to opacity 0 under [data-actions-reveal=hover] and on non-last user
           messages, so a child can never out-render its parent's opacity. Holding
           the row itself at 1 is what actually makes the button permanently
           visible. Scoped to rows that carry the host class, so it stops applying
           the moment Edit message is switched off or the editor is torn down. */
        .dsh-bu-edit-host [class*="_actions"] {
          opacity: 1 !important;
        }
        .dsh-bu-edit-btn > svg {
          display: block;
          flex: none;
          overflow: visible;
        }
        .dsh-bu-edit-btn:focus-visible {
          outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6);
          outline-offset: 1px;
        }
        .dsh-bu-edit-host,
        .dsh-bu-edit-host * {
          pointer-events: auto;
        }
        .dsh-bu-edit-btn:hover {
          color: var(--dsw-alias-label-primary);
        }
        .dsh-bu-edit-btn[data-armed="true"] {
          color: var(--dsw-alias-state-business-primary, #60a5fa);
        }
      `;
      document.head.appendChild(tag);
    }

    // ---------------------------------------------------------------------
    // Message editor (edit-and-resend)
    // ---------------------------------------------------------------------

    /**
     * HOW EDIT-AND-RESEND WORKS HERE — read this before changing anything below.
     *
     * A DSH transcript is a fold over an APPEND-ONLY event log; no supported API
     * rewrites a committed message (verified against this build: the only
     * history-shaping remote method is `session.fork`). What the product DOES
     * support is cutting a new session from a completed-turn prefix:
     *
     *   session.fork({ sessionId, atSeq })
     *
     * The host resolves `atSeq` to "the first `turn/end` at or after it" and cuts
     * the child right after that boundary. So to re-run from a message in turn N
     * we fork with the closing anchor of turn N-1: the child holds everything
     * BEFORE the message we are replacing, and then we send the rewritten text
     * into the child.
     *
     * The rewrite is therefore a branch, never an in-place edit — the original
     * session stays untouched, which is what the Settings page tells the user.
     *
     * Turn → closing-anchor seq is learned from the `conversation.chat.turnTail`
     * slot (chain slot, session scope): it receives `{ turn, seq }` where `seq` is
     * the turn's final assistant message seq — exactly the value the native
     * branch button passes to `forkAt`.
     */

    /** turn number -> closing anchor seq, learned from the turnTail slot. */
    const turnEndSeq = new Map();
    /** Session the anchor map above belongs to (cleared when it changes). */
    let anchorSessionId = null;
    /** sessionId -> turn number for the currently scoped session. */
    let editorScopeSessionId = null;
    let editorObserver = null;
    let editorScanTimer = null;
    let editorRunning = false;
    let editorFeatureWanted = false;
    let editorOverlay = null;
    /**
     * Whether "delete the old session" is checked by default in the edit dialog.
     * On by default: without it the turns after the edit remain in the session
     * list as a dead end, which is not what "edit this message" means to a user.
     * The choice is remembered for as long as the page lives.
     */
    let retireOriginalPreference = true;

    /**
     * React component that only records turn anchors; renders nothing.
     *
     * `editorScopeSessionId` is the session the turn-tail chain is bound to. The
     * anchor map is per-session, so a switch discards it — otherwise a turn number
     * from the previous session could be used as a fork anchor in the new one.
     */
    function TurnAnchorProbe(props) {
      if (editorScopeSessionId !== anchorSessionId) {
        anchorSessionId = editorScopeSessionId;
        turnEndSeq.clear();
      }
      const turn = props?.turn;
      const seq = props?.seq;
      if (typeof turn === 'number' && typeof seq === 'number' && Number.isFinite(seq)) {
        turnEndSeq.set(turn, seq);
      }
      return null;
    }

    const EDIT_HOST_CLASS = 'dsh-bu-edit-host';
    const EDIT_BTN_CLASS = 'dsh-bu-edit-btn';
    const EDIT_DATA_ATTR = 'data-better-uiux-edit';
    /**
     * The Edit button's glyph: DSH's OWN edit icon, so the injected action is
     * visually indistinguishable from the native ones in the same row.
     *
     * Copied verbatim from `IconEditOutline16` in
     * `@deepseek-ai/dsh-client-ui-primitives` (`ic_ds_edit_outline_16`): a 16x16
     * box, a single FILLED path coloured by `currentColor` — note `fill`, not
     * `stroke`, which is why this matches the shell's weight exactly instead of
     * approximating it. The trailing sub-path is the underline.
     *
     * Kept as a literal rather than `require`-ing the primitives package: this
     * module must not depend on the shell's internal export surface, and the
     * markup is smaller than the dependency. If DSH ever restyles the icon, this
     * is the one string to update.
     */
    const EDIT_ICON_SVG = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"',
      ' fill="none" aria-hidden="true" focusable="false">',
      '<path fill="currentColor" d="M9.94076 1.34942C10.7047 0.90231 11.6503 0.902415 12.4143 1.34942C12.7061 1.52015 12.9688 1.79118 13.3104 2.13284C13.6521 2.47448 13.9231 2.73721 14.0939 3.02894C14.5408 3.79294 14.5409 4.73856 14.0939 5.50251C13.9231 5.79415 13.652 6.05704 13.3104 6.39861L6.65932 13.0497C6.28068 13.4284 6.00695 13.7108 5.66543 13.9097C5.32391 14.1085 4.94315 14.2074 4.42705 14.3498L3.24394 14.6761C2.77527 14.8054 2.34538 14.9262 2.00131 14.9684C1.65196 15.0112 1.17964 15.0013 0.810764 14.6325C0.441921 14.2637 0.432107 13.7913 0.47486 13.442C0.517035 13.0979 0.6379 12.668 0.767181 12.1993L1.09352 11.0162C1.23588 10.5001 1.33481 10.1193 1.5336 9.77784C1.7325 9.43632 2.0149 9.1626 2.39355 8.78395L9.04466 2.13284C9.38625 1.79126 9.64911 1.52016 9.94076 1.34942ZM15.5427 14.8398H7.55223L8.96707 13.425H15.5427V14.8398ZM3.39382 9.78422C2.965 10.213 2.84244 10.3436 2.75709 10.49C2.67183 10.6366 2.61862 10.8079 2.45733 11.3925L2.13099 12.5756C2.00183 13.0439 1.92194 13.3419 1.88863 13.5536C2.10041 13.5204 2.39872 13.4416 2.86764 13.3123L4.05075 12.9859C4.63544 12.8246 4.80669 12.7715 4.95323 12.6862C5.09968 12.6008 5.23022 12.4783 5.65905 12.0494L10.721 6.98644L8.45577 4.72121L3.39382 9.78422ZM11.7 2.57079C11.3774 2.38198 10.9777 2.38198 10.6551 2.57079C10.5602 2.62647 10.4487 2.72931 10.0449 3.13311L9.45604 3.72094L11.7213 5.98617L12.3102 5.39833C12.7139 4.99457 12.8168 4.88307 12.8725 4.78818C13.0613 4.46561 13.0612 4.06585 12.8725 3.74326C12.8169 3.64827 12.7146 3.53752 12.3102 3.13311C11.9057 2.72863 11.795 2.6264 11.7 2.57079Z"/>',
      '</svg>'
    ].join('');

    /**
     * The shell's own labels for its copy button, read from
     * `@deepseek-ai/dsh-client-locale` COMMON_NS: `copy: "Copy" | "复制"`,
     * `copied: "Copied" | "复制成功"`. The button's aria-label flips to the
     * "copied" text for a second after a click, so both are listed.
     */
    const COPY_LABELS = new Set(['copy', 'copied', '复制', '复制成功']);

    /** Selector for one rendered user-message row. */
    const USER_ROW_SELECTOR = '[data-chat-flow-kind="user"][data-chat-flow-key]';

    /** Is this element (or an ancestor) one of ours? */
    function isOurs(node) {
      if (node === null || node === undefined || typeof node.closest !== 'function') return false;
      return node.closest(`.${EDIT_HOST_CLASS}, .${EDIT_BTN_CLASS}, .dsh-bu-overlay`) !== null;
    }

    /** Read the plain text a user message currently shows. */
    function readRowText(row) {
      const parts = [];
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (parent === null) return NodeFilter.FILTER_REJECT;
          if (parent.closest(`.${EDIT_HOST_CLASS}, .${EDIT_BTN_CLASS}, button, svg, script, style`)) {
            return NodeFilter.FILTER_REJECT;
          }
          return node.nodeValue !== null && node.nodeValue.trim() !== ''
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
      });
      let node = walker.nextNode();
      while (node !== null) {
        parts.push(node.nodeValue);
        node = walker.nextNode();
      }
      return parts.join('\n').trim();
    }

    /** The turn number a rendered user row belongs to. */
    function readRowTurn(row) {
      const raw = row.getAttribute('data-chat-turn');
      if (raw === null) return null;
      const value = Number.parseInt(raw, 10);
      return Number.isFinite(value) ? value : null;
    }

    /** Session id currently on screen, from the sessions service when available. */
    function activeSessionId() {
      if (editorScopeSessionId !== null) return editorScopeSessionId;
      try {
        const sessions = exports.__internals?.sessions;
        const selected = sessions?.list?.getSnapshot?.()?.selectedId;
        if (typeof selected === 'string' && selected.length > 0) return selected;
      } catch {
        /* fall through */
      }
      return null;
    }

    /**
     * Pick the seq to fork at so that the child ends just BEFORE `turn`.
     *
     * Preferred anchor is the closing seq of turn `turn - 1`. If that specific
     * turn is missing from the map — which happens when an earlier turn never
     * rendered its tail in this page session — the largest known anchor below
     * `turn` is used instead. That keeps the cut "before the edited message"
     * under all circumstances, which is the property that matters: a cut that is
     * too early only carries extra context into the branch, while a cut that is
     * too late would leave the old message in place.
     *
     * @param {number} turn - the turn holding the message being edited.
     * @returns {number|null} the anchor seq, or null when nothing usable is known.
     */
    function resolveForkAnchor(turn) {
      const exact = turnEndSeq.get(turn - 1);
      if (typeof exact === 'number' && Number.isFinite(exact)) return exact;
      let best = null;
      for (const [knownTurn, seq] of turnEndSeq) {
        if (knownTurn >= turn) continue;
        if (typeof seq !== 'number' || !Number.isFinite(seq)) continue;
        if (best === null || knownTurn > best.turn) best = { turn: knownTurn, seq };
      }
      return best === null ? null : best.seq;
    }

    /**
     * A short, actionable description of why an edit failed.
     *
     * `SessionForkError.rpcError.code` is the useful part (`turn-open`,
     * `session-busy`, …); the fallback is the message. Deliberately never returns
     * an empty string, because "(undefined)" in the dialog is worse than useless.
     */
    function describeFailure(error) {
      const code = error?.rpcError?.code;
      if (typeof code === 'string' && code.length > 0) {
        const detail = error?.rpcError?.message;
        return typeof detail === 'string' && detail.length > 0 ? `${code}: ${detail}` : code;
      }
      if (typeof error?.message === 'string' && error.message.length > 0) return error.message;
      return String(error);
    }

    /**
     * Edit = branch at turn N-1, resend, and OPTIONALLY retire the original.
     *
     * The platform cannot rewrite a turn in place: the log is append-only and no
     * `rewind` / `editMessage` exists. The observable outcome the user wants —
     * "turn 3 replaced, turns 4 and 5 gone" — is reachable with two supported
     * calls:
     *
     *   1. `sessions.fork({ atSeq: closingSeqOf(N-1) })` cuts a prefix ending
     *      exactly where the edited message begins. Dropping every later turn is
     *      what the cut IS; it is not a separate step.
     *   2. `sessions.delete(originalId)` retires the old session, so the dead-end
     *      tail does not sit in the list next to the live branch.
     *
     * Step 2 destroys data, so it is EXPLICIT (`retireOriginal`) and never a
     * silent default: the fork creates, the delete destroys.
     *
     * @param {string} sessionId - the session on screen.
     * @param {number} turn - the turn holding the message being replaced.
     * @param {string} text - the rewritten message.
     * @param {boolean} retireOriginal - delete the source session after branching.
     * @returns {Promise<{childId: string, retired: boolean, retireError: string|null}>}
     */
    async function resendEditedMessage(sessionId, turn, text, retireOriginal = false) {
      const sessions = exports.__internals?.sessions;
      if (sessions === undefined || sessions === null) throw new Error('sessions service unavailable');

      // The fork cut must land on the turn BEFORE the edited message: the host
      // resolves `atSeq` to "the first turn/end at or after it", so anchoring on
      // the edited turn's own closing seq would cut AFTER it and leave the old
      // text in the child.
      //
      // Anchors are learned lazily from the turnTail chain slot, so this can be
      // racily empty (the transcript must have rendered, and a session switch
      // clears the map). A missing anchor is reported with the exact turn and the
      // anchors actually known, because "no completed turn before the edited
      // message" on its own is not enough to tell a missing probe from an
      // off-by-one turn number.
      const anchor = resolveForkAnchor(turn);
      if (anchor === null) {
        const known = [...turnEndSeq.keys()].sort((a, b) => a - b);
        throw new Error(
          `no anchor for turn ${turn - 1} (edited turn ${turn}; known anchors: ${known.length === 0 ? 'none - the turn anchor probe has not run' : known.join(', ')})`
        );
      }

      // `ClientSessions.fork` RESOLVES TO THE CHILD ID STRING and throws
      // `SessionForkError`. It is not an `{ok, value}` envelope: reading it as one
      // made `childId` always null, so every edit threw and silently queued a new
      // message in the current session instead of branching.
      const childId = await sessions.fork({ sessionId, atSeq: anchor, increaseTitle: true });
      if (typeof childId !== 'string' || childId.length === 0) {
        throw new Error('fork did not return a child session id');
      }

      // Follow the branch BEFORE touching the original, so the view is never left
      // pointing at a session that is about to disappear.
      sessions.open(childId);
      const binding = sessions.binding(childId);
      const child = binding?.session;
      if (child === undefined || child === null) throw new Error('forked session is not addressable');

      const result = await child.prompt([{ type: 'text', text }], 'queue');
      if (result?.ok !== true) {
        const code = result?.error?.code ? ` (${result.error.code})` : '';
        throw new Error(`prompt failed${code}`);
      }

      let retired = false;
      let retireError = null;
      if (retireOriginal === true) {
        try {
          await sessions.delete(sessionId);
          retired = true;
        } catch (error) {
          // The branch is already live and holds the text, so a failed retire is a
          // partial success: report it instead of failing the whole edit.
          retireError = error?.rpcError?.code ?? error?.message ?? String(error);
          console.warn('[better-uiux] could not retire the original session:', error);
        }
      }

      return { childId, retired, retireError };
    }

    /**
     * Send `text` into the session as a NEW message (an append).
     *
     * NOT a fallback any more. It used to be called automatically when branching
     * failed, which silently turned a failed edit into an appended message; the
     * edit path now reports the failure and changes nothing. Appending is a
     * deliberate user choice instead — today via "Fill into composer", which goes
     * through the real composer and therefore keeps @-mentions and / commands.
     * Kept and exported because it is the documented escape hatch and is covered
     * by tests.
     */
    async function resendInCurrentSession(sessionId, text) {
      const sessions = exports.__internals?.sessions;
      const binding = sessions?.binding?.(sessionId);
      const session = binding?.session;
      if (session === undefined || session === null) throw new Error('session is not addressable');
      const result = await session.prompt([{ type: 'text', text }], 'queue');
      if (result?.ok !== true) {
        const code = result?.error?.code ? ` (${result.error.code})` : '';
        throw new Error(`prompt failed${code}`);
      }
    }

    // ---------------------------------------------------------------------
    // Composer hand-off
    //
    // "Fill into composer" puts the message into the REAL composer instead of
    // resending it, so the user keeps every composer feature while rewriting:
    // @-file mentions, / commands, attachments, draft history, the lot.
    //
    // The composer CANNOT be embedded in a modal: it is a singleton bound to one
    // DOM seat, over a session-scoped Lexical editor shared through the provide
    // channel, and its contenteditable is swapped into that seat once. What a
    // plugin can do is write through the same public channel the shell itself
    // uses:
    //
    //   conversation.input.for(actx)  ->  SessionInputShell
    //   shell.actions.setDraft(text)  ->  replaces the draft, caret at the end
    //   shell.actions.submit()        ->  equivalent of pressing send
    //
    // `actx` is the session-scope context, which the sessions service exposes as
    // `sessions.binding(sessionId).ctx`. `setDraft` is the documented
    // programmatic-write path (the persisted-draft seed is written with it), so
    // this is not a DOM hack.
    // ---------------------------------------------------------------------

    /**
     * Resolve the per-session composer facade, or null when it is unreachable.
     * @returns {object|null} the `SessionInputShell` for this session.
     */
    function composerShell(sessionId) {
      const conversation = composerService;
      if (conversation === null || conversation === undefined) return null;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
      const ctx = exports.__internals.sessions?.binding?.(sessionId)?.ctx;
      if (ctx === undefined || ctx === null) return null;
      try {
        return conversation.input?.for?.(ctx) ?? null;
      } catch (error) {
        console.warn('[better-uiux] composer facade unavailable:', error);
        return null;
      }
    }

    /**
     * Move focus into the composer without disturbing the caret: the
     * contenteditable already owns Lexical, so `.focus()` is the whole job.
     * @returns {boolean} whether a composer input element was found.
     */
    function focusComposer() {
      const seat = document.querySelector('[data-composer-input] [contenteditable], [data-composer-input]');
      if (seat === null) return false;
      try {
        seat.focus();
      } catch {
        return false;
      }
      return true;
    }

    /**
     * Write `text` into the session's real composer and focus it.
     * Never throws: the caller reports the outcome inside the modal.
     * @returns {{ ok: boolean, focused: boolean, reason?: string }}
     */
    function fillComposer(sessionId, text) {
      const shell = composerShell(sessionId);
      if (shell === null) return { ok: false, focused: false, reason: 'no-composer' };
      const actions = shell.actions;
      if (actions === null || actions === undefined || typeof actions.setDraft !== 'function') {
        return { ok: false, focused: false, reason: 'no-setDraft' };
      }
      try {
        actions.setDraft(text);
      } catch (error) {
        console.warn('[better-uiux] setDraft failed:', error);
        return { ok: false, focused: false, reason: 'setDraft-threw' };
      }
      // The editor commits discretely; focus on the next frame so the caret
      // lands after Lexical has re-rendered the paragraphs.
      window.requestAnimationFrame(() => focusComposer());
      return { ok: true, focused: focusComposer() };
    }

    /**
     * The user message's icon-action row — the `MessageIconActions` container that
     * holds the native copy button (and the clock).
     *
     * Located RELATIVE to the shell's own copy button rather than by class name:
     * the row's class is a CSS-module hash (`qJxi1G_actions`) that changes on every
     * DSH rebuild, and hard-coding today's hash would silently stop matching after
     * an update. Preference order:
     *   1. a button whose aria-label is the shell's copy/copied text,
     *   2. any labelled button in the row (covers a shell that swaps the glyph),
     *   3. any element whose class looks like the module's `_actions` wrapper.
     *
     * @returns {{ container: object, copyButton: object|null }} the row and the
     *   copy button inside it (the anchor the Edit button is inserted before).
     */
    function findActionRow(row) {
      const buttons = [...row.querySelectorAll('button[aria-label]')];
      const copy = buttons.find((button) =>
        COPY_LABELS.has((button.getAttribute('aria-label') ?? '').trim().toLowerCase())
      ) ?? null;
      const anchor = copy ?? buttons[0] ?? null;
      if (anchor !== null && anchor.parentElement !== null) {
        return { container: anchor.parentElement, copyButton: copy };
      }
      return { container: row.querySelector('[class*="_actions"]'), copyButton: null };
    }

    /**
     * The clock span the shell renders BEFORE the copy button, i.e.
     * `clockEl = <span class="…_timeStart">18:02</span>`.
     *
     * Identified by a class ending in `_timeStart` / `_timeEnd` (the module's own
     * public key names, stable across rebuilds — only the hash prefix changes).
     * Only used as a fallback now that Edit sits AFTER the copy button; it keeps
     * the button in a sane place on rows whose action shape is unusual.
     *
     * @returns {object|null} the clock element, or null when this row has none.
     */
    function findClockSibling(container) {
      for (const child of container.children) {
        const className = typeof child.className === 'string' ? child.className : '';
        if (/(^|\s)\S*_time(Start|End)(\s|$)/.test(className)) return child;
      }
      return null;
    }

    /** Install one Edit button on a user-message row (idempotent per row). */
    function decorateRow(row) {
      const label = translations().editAction;
      if (row.getAttribute(EDIT_DATA_ATTR) === 'host') {
        // Same row, but the message may have re-rendered its action row out from
        // under us (React replaces the subtree). Re-home the button if it moved.
        const existing = row.querySelector(`.${EDIT_BTN_CLASS}`);
        if (existing !== null) {
          const { container, copyButton } = findActionRow(row);
          if (container !== null && existing.parentElement !== container) {
            placeEditButton(container, copyButton, existing);
          }
        }
        return;
      }
      if (row.querySelector(`.${EDIT_BTN_CLASS}`) !== null) return;

      row.setAttribute(EDIT_DATA_ATTR, 'host');
      row.classList.add(EDIT_HOST_CLASS);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = EDIT_BTN_CLASS;
      button.setAttribute('aria-label', label);
      button.title = label;
      button.innerHTML = EDIT_ICON_SVG;

      const { container, copyButton } = findActionRow(row);
      if (container !== null) {
        placeEditButton(container, copyButton, button);
      } else {
        // No icon row to join (an unusual message shape) — keep the affordance.
        const bubble = row.querySelector('[class*="bubble" i]') ?? row.lastElementChild ?? row;
        bubble.appendChild(button);
      }

      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openEditorForRow(row);
      });
    }

    /**
     * Put the Edit button AFTER the copy button, i.e. last in the action row.
     *
     * Positioning is anchored on the copy button's `nextSibling` rather than on
     * an index or a class name, so it lands immediately right of copy whatever
     * else the row contains. `nextSibling` may be null (copy is last), which is
     * exactly the append case.
     *
     * When there is no copy button to anchor on, the button falls back to the end
     * of the row, then to just after the clock, then to the row's end — the goal
     * is only that it stays visible and clickable on unusual message shapes.
     */
    function placeEditButton(container, copyButton, button) {
      if (copyButton !== null && copyButton.parentElement === container) {
        container.insertBefore(button, copyButton.nextSibling);
        return;
      }
      const clock = findClockSibling(container);
      if (clock !== null) {
        container.insertBefore(button, clock.nextSibling);
        return;
      }
      container.appendChild(button);
    }

    /** Add the button to every user row that lacks one. */
    function decorateAll() {
      const rows = document.querySelectorAll(USER_ROW_SELECTOR);
      for (const row of rows) decorateRow(row);
    }

    /** Remove every trace of the editor from the transcript. */
    function decorateCleanup() {
      for (const row of document.querySelectorAll(`[${EDIT_DATA_ATTR}="host"]`)) {
        row.removeAttribute(EDIT_DATA_ATTR);
        row.classList.remove(EDIT_HOST_CLASS);
      }
      for (const button of document.querySelectorAll(`.${EDIT_BTN_CLASS}`)) button.remove();
      closeEditor();
    }

    function scanForRows() {
      if (!editorFeatureWanted) return;
      decorateAll();
    }

    function scheduleScan() {
      if (editorScanTimer !== null) return;
      editorScanTimer = window.setTimeout(() => {
        editorScanTimer = null;
        scanForRows();
      }, 150);
    }

    // ---------------------------------------------------------------------
    // Editor overlay
    // ---------------------------------------------------------------------

    function closeEditor() {
      if (editorOverlay === null) return;
      editorOverlay.root.remove();
      editorOverlay = null;
    }

    function openEditorForRow(row) {
      closeEditor();

      const turn = readRowTurn(row);
      const original = readRowText(row);
      const sessionId = activeSessionId();
      // Remembered across dialog openings: retiring the original is the behaviour
      // that actually makes "turns 4 and 5" disappear, so it defaults ON and the
      // user's choice sticks for the session.
      const retireOriginalDefault = retireOriginalPreference;

      const root = document.createElement('div');
      root.className = 'dsh-bu-overlay';
      root.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483000',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'background:rgba(0,0,0,0.45)',
        'padding:24px'
      ].join(';');

      const panel = document.createElement('div');
      panel.style.cssText = [
        'width:min(760px,100%)',
        'max-height:80vh',
        'display:flex',
        'flex-direction:column',
        'gap:12px',
        'padding:16px',
        'border-radius:16px',
        'border:0.5px solid var(--dsw-alias-border-l4,#3a3a3a)',
        'background:var(--dsw-alias-bg-layer-3,#1c1c1c)',
        'color:var(--dsw-alias-label-primary,#eee)',
        'box-shadow:0 24px 60px rgba(0,0,0,0.5)',
        'font-size:13px'
      ].join(';');

      const title = document.createElement('div');
      title.textContent = translations().editTitle;
      title.style.cssText = 'font-size:15px;font-weight:600;line-height:1.4';

      const hint = document.createElement('div');
      hint.textContent = turn === null
        ? translations().editUnavailable
        : translations().editHint;
      hint.style.cssText = 'font-size:12px;line-height:1.55;opacity:0.72';

      const textarea = document.createElement('textarea');
      textarea.value = original;
      textarea.spellcheck = false;
      textarea.style.cssText = [
        'box-sizing:border-box',
        'width:100%',
        'min-height:180px',
        'max-height:52vh',
        'resize:vertical',
        'padding:12px',
        'border-radius:12px',
        'border:0.5px solid var(--dsw-alias-border-l4,#3a3a3a)',
        'background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,0.25))',
        'color:inherit',
        'font-family:var(--dsw-font-markdown-code-block,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)',
        'font-size:12.5px',
        'line-height:1.6',
        'outline:none'
      ].join(';');

      const status = document.createElement('div');
      status.style.cssText = 'font-size:12px;line-height:1.5;min-height:18px;opacity:0.8';

      // The turns after the edited message can only go away by retiring the whole
      // source session. That destroys data, so it is an explicit, opt-in choice
      // rather than something done quietly on the user's behalf.
      const retireRow = document.createElement('label');
      retireRow.style.cssText = 'display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:12px;line-height:1.5;opacity:0.85';
      const retireBox = document.createElement('input');
      retireBox.type = 'checkbox';
      retireBox.checked = retireOriginalDefault;
      retireBox.disabled = turn === null;
      retireBox.style.cssText = 'margin:2px 0 0;flex:none;accent-color:var(--dsw-alias-brand-primary,#3b82f6)';
      const retireText = document.createElement('span');
      retireText.textContent = translations().editRetire;
      retireText.title = translations().editRetireHint;
      retireRow.appendChild(retireBox);
      retireRow.appendChild(retireText);

      const footer = document.createElement('div');
      footer.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap';

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = translations().editCancel;
      cancel.style.cssText = 'border:0.5px solid var(--dsw-alias-border-l4,#3a3a3a);background:transparent;color:inherit;border-radius:10px;padding:7px 14px;cursor:pointer;font-size:12.5px';

      // Secondary action: hand the text to the REAL composer instead of resending
      // it here, so the rewrite can use @-mentions, / commands and attachments.
      const toComposer = document.createElement('button');
      toComposer.type = 'button';
      toComposer.textContent = translations().editComposer;
      toComposer.title = `${translations().editComposerHint}\n\n${translations().editComposerNote}`;
      toComposer.style.cssText = 'border:0.5px solid var(--dsw-alias-border-l4,#3a3a3a);background:transparent;color:inherit;border-radius:10px;padding:7px 14px;cursor:pointer;font-size:12.5px';

      const save = document.createElement('button');
      save.type = 'button';
      save.textContent = translations().editSave;
      save.title = translations().editSaveHint;
      save.style.cssText = 'border:0;background:var(--dsw-alias-brand-primary,#3b82f6);color:var(--dsw-alias-label-primary-foreground,#fff);border-radius:10px;padding:7px 14px;cursor:pointer;font-size:12.5px;font-weight:500';

      /** Left cluster (cancel + composer), right cluster (primary send). */
      const footerLeft = document.createElement('div');
      footerLeft.style.cssText = 'display:flex;align-items:center;gap:8px';
      const footerRight = document.createElement('div');
      footerRight.style.cssText = 'display:flex;align-items:center;gap:8px';

      let busy = false;
      const setBusy = (value) => {
        busy = value;
        save.disabled = value;
        cancel.disabled = value;
        toComposer.disabled = value;
        save.style.opacity = value ? '0.6' : '1';
        cancel.style.opacity = value ? '0.6' : '1';
        toComposer.style.opacity = value ? '0.6' : '1';
        textarea.style.opacity = value ? '0.7' : '1';
      };

      const finish = (message, isError) => {
        status.textContent = message;
        status.style.color = isError
          ? 'var(--dsw-alias-label-error,#f87171)'
          : 'var(--dsw-alias-state-business-primary,#60a5fa)';
      };

      cancel.addEventListener('click', closeEditor);

      toComposer.addEventListener('click', () => {
        if (busy) return;
        const text = textarea.value.trim();
        if (text.length === 0) {
          finish(translations().editEmpty, true);
          return;
        }
        const outcome = fillComposer(sessionId, text);
        if (!outcome.ok) {
          finish(`${translations().editComposerUnavailable} (${outcome.reason})`, true);
          return;
        }
        finish(translations().editComposerFilled, false);
        // Close so the user lands on the composer they just filled.
        window.setTimeout(closeEditor, 400);
      });

      save.addEventListener('click', async () => {
        if (busy) return;
        const text = textarea.value.trim();
        if (text.length === 0) {
          finish(translations().editEmpty, true);
          return;
        }
        if (text === original.trim()) {
          closeEditor();
          return;
        }
        if (turn === null || sessionId === null) {
          finish(translations().editUnavailable, true);
          return;
        }

        setBusy(true);
        finish(translations().editBusy, false);
        // Remember the user's stance on retiring the original before the attempt,
        // so a failure does not silently flip it.
        retireOriginalPreference = retireBox.checked;
        try {
          const outcome = await resendEditedMessage(sessionId, turn, text, retireBox.checked);
          setBusy(false);
          if (outcome?.retireError !== null && outcome?.retireError !== undefined) {
            finish(`${translations().editRetireFailed} (${outcome.retireError})`, true);
          } else if (outcome?.retired === true) {
            finish(translations().editSentRetired, false);
          } else {
            finish(translations().editSentKeptOld, false);
          }
          window.setTimeout(closeEditor, 900);
        } catch (error) {
          // NO SILENT FALLBACK.
          //
          // This used to catch a failed branch and quietly append the message to
          // the current session instead. That turned every branch failure into
          // "my edit got added as a new message", which reads as a broken feature
          // and destroys the thing the user was trying to do. A failed edit now
          // reports the real reason and changes NOTHING. Appending is available
          // deliberately, via the composer hand-off button.
          console.warn('[better-uiux] branch failed:', error);
          const reason = describeFailure(error);
          setBusy(false);
          finish(`${translations().editFailed} (${reason})`, true);
        }
      });

      textarea.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeEditor();
          return;
        }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          save.click();
        }
      });

      root.addEventListener('click', (event) => {
        if (event.target === root) closeEditor();
      });

      footerLeft.appendChild(cancel);
      footerLeft.appendChild(toComposer);
      footerRight.appendChild(save);
      footer.appendChild(footerLeft);
      footer.appendChild(footerRight);
      panel.appendChild(title);
      panel.appendChild(hint);
      panel.appendChild(textarea);
      panel.appendChild(retireRow);
      panel.appendChild(status);
      panel.appendChild(footer);
      root.appendChild(panel);
      document.body.appendChild(root);

      editorOverlay = { root, textarea };
      window.setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }, 0);
    }

    /** Best-effort access to the bound translator for DOM-built chrome. */
    let boundTranslator = null;
    /** The conversation service (`conversation.input.for`), or null when absent. */
    let composerService = null;
    function translations() {
      if (boundTranslator !== null) {
        return {
          editAction: boundTranslator('editAction'),
          editTitle: boundTranslator('editTitle'),
          editHint: boundTranslator('editHint'),
          editSave: boundTranslator('editSave'),
          editSaveHint: boundTranslator('editSaveHint'),
          editRetire: boundTranslator('editRetire'),
          editRetireHint: boundTranslator('editRetireHint'),
          editSentRetired: boundTranslator('editSentRetired'),
          editSentKeptOld: boundTranslator('editSentKeptOld'),
          editRetireFailed: boundTranslator('editRetireFailed'),
          editComposer: boundTranslator('editComposer'),
          editComposerHint: boundTranslator('editComposerHint'),
          editComposerFilled: boundTranslator('editComposerFilled'),
          editComposerUnavailable: boundTranslator('editComposerUnavailable'),
          editComposerNote: boundTranslator('editComposerNote'),
          editCancel: boundTranslator('editCancel'),
          editBusy: boundTranslator('editBusy'),
          editSent: boundTranslator('editSent'),
          editFailed: boundTranslator('editFailed'),
          editEmpty: boundTranslator('editEmpty'),
          editUnavailable: boundTranslator('editUnavailable')
        };
      }
      return {
        editAction: 'Edit',
        editTitle: 'Edit message',
        editHint: 'Saving restarts from this message: the new session keeps everything before it.',
        editSave: 'Save & resend',
        editSaveHint: 'Resend in a new branch session',
        editRetire: 'Delete the old session (drops every turn after this message)',
        editRetireHint: 'After the branch is created, delete the source session. That is what makes turns 4 and 5 disappear — they cannot be deleted individually.',
        editSentRetired: 'Resent in a new session, and the old one was deleted',
        editSentKeptOld: 'Resent in a new session (the old one is kept)',
        editRetireFailed: 'Branch created, but the old session could not be deleted',
        editComposer: 'Fill into composer',
        editComposerHint: 'Put this text in the real composer, so you get @-mentions, / commands, attachments and the rest',
        editComposerFilled: 'Filled into the composer — press send when ready',
        editComposerUnavailable: 'The composer is not available right now',
        editComposerNote: 'Note: sending from the composer appends a NEW message to this session; it does not re-run from this point.',
        editCancel: 'Cancel',
        editBusy: 'Creating the branch session…',
        editSent: 'Resent in a new session',
        editFailed: 'Could not branch, so nothing was changed. Use "Fill into composer" if you want it as a normal message instead.',
        editEmpty: 'The message cannot be empty.',
        editUnavailable: 'This turn has not finished yet, so it cannot be edited.'
      };
    }

    function startMessageEditor() {
      if (editorRunning) return;
      editorRunning = true;

      editorObserver = new MutationObserver((mutations) => {
        if (!editorFeatureWanted) return;
        for (const mutation of mutations) {
          if (isOurs(mutation.target)) continue;
          scheduleScan();
          return;
        }
      });
      editorObserver.observe(document.body, { childList: true, subtree: true });

      document.addEventListener('keydown', onEditorKeydown, true);
      scanForRows();
    }

    function stopMessageEditor() {
      if (!editorRunning) return;
      editorRunning = false;
      editorObserver?.disconnect();
      editorObserver = null;
      document.removeEventListener('keydown', onEditorKeydown, true);
      if (editorScanTimer !== null) {
        window.clearTimeout(editorScanTimer);
        editorScanTimer = null;
      }
      turnEndSeq.clear();
      decorateCleanup();
    }

    function onEditorKeydown(event) {
      if (event.key === 'Escape' && editorOverlay !== null) {
        event.preventDefault();
        event.stopPropagation();
        closeEditor();
      }
    }

    // ---------------------------------------------------------------------
    // Settings UI
    // ---------------------------------------------------------------------

    const { useState, useCallback, useRef, useEffect } = React;

    /**
     * Error boundary around the whole section.
     *
     * The shell wraps every slot entry in its own boundary, so an uncaught render
     * error here does not blank the app — it replaces the section with a
     * zero-height `<div data-slot-error="settings.section">`, i.e. a silent empty
     * page. Catching locally and printing the failure INSIDE the pane turns that
     * into something the user can see and report.
     */
    class SectionBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failure: null };
      }

      static getDerivedStateFromError(error) {
        return { failure: error };
      }

      componentDidCatch(error, info) {
        console.error('[better-uiux] section render failed:', error, info?.componentStack);
      }

      render() {
        const { failure } = this.state;
        if (failure === null) return this.props.children;
        return jsxs('div', {
          className: 'dsh-bu-section',
          children: [
            jsx('h2', { className: 'dsh-bu-heading', children: 'Better UIUX — render error' }),
            jsx('p', {
              className: 'dsh-bu-error',
              children: String(failure?.message ?? failure)
            }),
            jsx('pre', {
              className: 'dsh-bu-editor',
              children: String(failure?.stack ?? '').split('\n').slice(0, 12).join('\n')
            }),
            jsx('p', {
              className: 'dsh-bu-hint',
              children: 'Please report this stack together with the [better-uiux] console output.'
            })
          ]
        });
      }
    }

    /** One feature row with a switch. */
    function FeatureRow({ title, hint, on, disabled, onToggle }) {
      return jsxs('div', {
        className: 'dsh-bu-row',
        children: [
          jsxs('div', {
            className: 'dsh-bu-row-text',
            children: [
              jsx('span', { className: 'dsh-bu-row-title', children: title }),
              jsx('p', { className: 'dsh-bu-hint', children: hint })
            ]
          }),
          jsx('div', {
            className: 'dsh-bu-controls',
            children: jsx('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': on ? 'true' : 'false',
              'aria-label': title,
              disabled: disabled === true,
              className: 'dsh-bu-switch',
              'data-on': on ? 'true' : 'false',
              onClick: onToggle,
              children: jsx('span', { className: 'dsh-bu-thumb' })
            })
          })
        ]
      });
    }

    /** The whole Better UIUX page. */
    function BetterUiuxSection({ t }) {
      const { config: current, saveState: state, loadError: error } = useConfig();
      const [draft, setDraft] = useState(current.css);
      const lastPushed = useRef(current.css);

      useEffect(() => {
        if (current.css !== lastPushed.current) {
          lastPushed.current = current.css;
          setDraft(current.css);
        }
      }, [current.css]);

      const toggle = useCallback((key) => {
        setFeature(key, current.features[key] !== true);
      }, [current.features]);

      const onChange = useCallback((event) => {
        const value = event.target.value;
        lastPushed.current = value;
        setDraft(value);
        // Live inject on every keystroke; the host write is debounced.
        config = { ...config, css: value };
        applyCustomCss();
        notify();
        scheduleSave();
      }, []);

      const onBlur = useCallback(() => {
        flushSave();
      }, []);

      const onKeyDown = useCallback((event) => {
        // Escape leaves the textarea so the modal's own Escape-to-close works.
        if (event.key === 'Escape') event.currentTarget.blur();
      }, []);

      const onCount = FEATURE_KEYS.reduce((total, key) => total + (current.features[key] ? 1 : 0), 0);
      const isEmpty = draft.trim().length === 0;
      const cssPaused = current.features.customCss !== true && !isEmpty;

      let footnote = t('editorHint');
      let footnoteClass = 'dsh-bu-hint';
      if (error !== null) {
        footnote = t('loadError');
        footnoteClass = 'dsh-bu-error';
      } else if (state === 'error') {
        footnote = t('saveError');
        footnoteClass = 'dsh-bu-error';
      } else if (state === 'saving') {
        footnote = t('saving');
      } else if (cssPaused) {
        footnote = t('paused');
      }

      return jsxs('div', {
        className: 'dsh-bu-section',
        children: [
          jsx('h2', { className: 'dsh-bu-heading', children: t('heading') }),
          jsx('p', { className: 'dsh-bu-intro', children: t('intro') }),

          jsx('p', { className: 'dsh-bu-group-title', children: t('featuresHeading') }),
          jsxs('div', {
            className: 'dsh-bu-card',
            children: [
              jsx(FeatureRow, {
                title: t('liveTerminalLabel'),
                hint: t('liveTerminalHint'),
                on: current.features.liveTerminal === true,
                onToggle: () => toggle('liveTerminal')
              }),
              jsx(FeatureRow, {
                title: t('customCssLabel'),
                hint: t('customCssHint'),
                on: current.features.customCss === true,
                onToggle: () => toggle('customCss')
              }),
              jsxs('div', {
                className: 'dsh-bu-editor-block',
                children: [
                  jsxs('div', {
                    className: 'dsh-bu-editor-head',
                    children: [
                      jsx('span', { className: 'dsh-bu-editor-label', children: t('editorTitle') }),
                      jsx('span', {
                        className: 'dsh-bu-count',
                        children: isEmpty ? '0' : String(draft.length)
                      })
                    ]
                  }),
                  jsx('textarea', {
                    className: 'dsh-bu-editor',
                    spellCheck: false,
                    autoComplete: 'off',
                    autoCorrect: 'off',
                    autoCapitalize: 'off',
                    wrap: 'off',
                    'aria-label': t('editorTitle'),
                    placeholder: t('editorPlaceholder'),
                    value: draft,
                    onChange,
                    onKeyDown,
                    onBlur
                  }),
                  jsxs('div', {
                    className: 'dsh-bu-foot',
                    children: [
                      jsx('p', { className: footnoteClass, children: footnote }),
                      jsx('span', { className: 'dsh-bu-hint', children: t('external') })
                    ]
                  })
                ]
              })
            ]
          }),

          jsx('p', { className: 'dsh-bu-group-title', children: t('noteHeading') }),
          jsxs('div', {
            className: 'dsh-bu-note',
            children: [
              jsx('p', { className: 'dsh-bu-hint', children: t('enabledCount', { on: onCount, total: FEATURE_KEYS.length }) })
            ]
          })
        ]
      });
    }

    // ---------------------------------------------------------------------
    // Plugin entry
    // ---------------------------------------------------------------------

    /** Services this client plugin needs before it can contribute to Settings. */
    const inject = ['slots', 'locale'];

    /** The registered section: the pane's contents, behind a local boundary. */
    function GuardedBetterUiuxSection(props) {
      return jsx(SectionBoundary, { children: jsx(BetterUiuxSection, props) });
    }

    function apply(ctx) {
      ensureChromeStyles();

      ctx.effect(() => ctx.locale.register(NS, { zh, en, vi }), 'better-uiux: dictionaries');
      const t = ctx.locale.bind(NS);
      boundTranslator = t;

      // Diagnostic breadcrumbs: if the section ever renders empty in the GUI,
      // these two lines tell the user whether this bundle ran at all.
      console.info(`[better-uiux] client v${CLIENT_VERSION} initialized (nav: ${t('nav')})`);

      ctx.slots.inject(SECTION_SLOT, () =>
        ctx.slots.register(
          {
            name: SECTION_SLOT,
            id: 'better-uiux',
            order: 41,
            label: () => t('nav'),
            locale: NS
          },
          GuardedBetterUiuxSection
        )
      );

      // The message editor's turn-anchor probe rides the native turn-tail chain
      // slot. `inject` there receives the session id the chat view is bound to.
      try {
        ctx.inject(['sessions'], (child) => {
          exports.__internals.sessions = child.sessions;
        });
      } catch (error) {
        console.warn('[better-uiux] sessions service unavailable:', error);
      }

      // The composer service, for "fill into composer". Resolved lazily rather
      // than through a hard `inject` entry: it is an enhancement, and a
      // composition without the conversation UI must still get every other part
      // of this plugin instead of failing to activate at all.
      try {
        ctx.inject(['conversation'], (child) => {
          composerService = child.conversation ?? null;
        });
      } catch (error) {
        console.warn('[better-uiux] conversation service unavailable:', error);
      }

      ctx.slots.inject('conversation.chat.turnTail', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.turnTail',
            id: 'better-uiux-turn-anchor',
            order: 0,
            select: () => true,
            inject: (sessionId) => {
              if (typeof sessionId === 'string' && sessionId.length > 0) editorScopeSessionId = sessionId;
              return {};
            }
          },
          TurnAnchorProbe
        )
      );

      void loadFromHost();
    }

    // Apply the cached config synchronously, before the first paint of this bundle.
    const cached = readCache();
    if (cached !== null) config = cached;
    try {
      ensureChromeStyles();
      applyCustomCss();
    } catch (error) {
      console.warn('[better-uiux] Failed to apply the cached config:', error);
    }

    exports.apply = apply;
    exports.inject = inject;

    /** Hand-off surface for the live-terminal half (registered separately). */
    exports.__internals = {
      NS,
      GLOBAL_KEY,
      /** Read the current config document. */
      getConfig: () => config,
      /** Read one feature flag. */
      featureOn: (key) => config.features[key] === true,
      /** Subscribe to config changes; returns an unsubscriber. */
      subscribe,
      /**
       * Subscribe to feature-flag pushes. The listener runs on every change with
       * the whole `features` object, so the live-terminal half can start and tear
       * itself down without polling.
       * @param {(features: object) => void} listener - feature sink.
       * @returns {() => void} unsubscriber.
       */
      onFeatures: (listener) => {
        featureSyncListeners.add(listener);
        return () => featureSyncListeners.delete(listener);
      },
      /** Wait until the host answer (or its failure) has landed. */
      whenHydrated: () =>
        hydrated
          ? Promise.resolve()
          : new Promise((resolve) => {
              const off = subscribe(() => {
                if (hydrated) {
                  off();
                  resolve();
                }
              });
            }),
      messageEditorRunning: () => editorRunning,
      startMessageEditor,
      stopMessageEditor,
      fillComposer,
      resendEditedMessage,
      resendInCurrentSession,
      /** turn -> closing seq anchors, so tests can seed the fork point. */
      turnEndSeq,
      /**
       * Live diagnosis of the fork anchor state. Reachable from DevTools as
       * `__DSH_BETTER_UIUX__.anchorState()`; the anchor map is learned at runtime
       * from the turnTail slot, so when an edit reports a missing anchor this is
       * what says whether the probe ran at all.
       */
      anchorState: () => ({
        anchors: Object.fromEntries([...turnEndSeq.entries()].sort((a, b) => a[0] - b[0])),
        editorRunning,
        anchorSessionId,
        editorScopeSessionId
      }),
      resolveForkAnchor,
      sessions: null
    };
    // Published on the global for two reasons: `live-terminal.js` reads it through
    // this key for `featureOn` / `onFeatures` / `whenHydrated`, and the anchor map
    // is inspectable from DevTools as `__DSH_BETTER_UIUX__.anchorState()`.
    globalThis[GLOBAL_KEY] = exports.__internals;

    return module.exports;
  }
});
