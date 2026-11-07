// Isolated render probe (T4 full-layer acceptance helper).
//
// Loads the isolated DSH web URL in a real Chromium, waits for the workbench
// sidebar entry, opens the panel, verifies the fixture banner/cards/owner
// versions, exercises "return to chat" and "re-open", records console messages
// and captures a screenshot. Run by tools/isolated-profile-verify.mjs; it is
// not a shipped plugin component.
const {app, BrowserWindow} = require('electron');
const {writeFileSync} = require('node:fs');

const url = process.env.WB_URL;
const out = process.env.WB_OUT;
const shot = process.env.WB_SHOT;
const consoleLines = [];

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

function finish(payload) {
  try {
    writeFileSync(out, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error('probe write failed', String(error));
  }
  app.exit(payload.ok === true ? 0 : 1);
}

async function waitFor(win, expression, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await win.webContents.executeJavaScript(expression).catch(() => false);
    if (value) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function clickWorkbenchEntry() {
  return `(() => {
    const buttons = [...document.querySelectorAll('button')];
    const button = buttons.find((item) => (item.getAttribute('aria-label') || '').includes('本地工作台') || item.textContent.includes('本地工作台'));
    if (!button) return {ok: false, buttons: buttons.length};
    button.click();
    return {ok: true, label: button.getAttribute('aria-label') || button.textContent.slice(0, 40)};
  })()`;
}

// The product's own first-run preview notice / onboarding card (host UI, not
// the workbench) may mount after the shell settles. Retry until they are gone
// so the evidence image shows the workbench panel.
async function dismissProductNotice(win) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await win.webContents.executeJavaScript(`(() => {
      const visibleDialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const preview = visibleDialogs.some((element) => element.innerText.includes('预览版说明'));
      const onboarding = visibleDialogs.some((element) => element.innerText.includes('开始使用'));
      if (!preview && !onboarding) return {done: true};
      let clicked = false;
      if (preview) {
        const button = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '继续');
        if (button) {
          button.click();
          clicked = true;
        }
      }
      if (!clicked && onboarding) {
        const later = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '稍后配置');
        if (later) {
          later.click();
          clicked = true;
        }
      }
      if (!clicked) {
        const closer = [...document.querySelectorAll('button')].find((node) => {
          const label = node.getAttribute('aria-label') || '';
          const text = node.textContent.trim();
          return /关闭|Close|close/.test(label) || text === '×' || text === '✕';
        });
        if (closer) {
          closer.click();
          clicked = true;
        }
      }
      if (!clicked && onboarding) {
        // Some host onboarding dialogs render an icon-only close button at the
        // dialog's top-right; target it positionally inside the matching dialog.
        const dialog = visibleDialogs.find((element) => element.innerText.includes('开始使用'));
        if (dialog) {
          const bounds = dialog.getBoundingClientRect();
          const candidate = [...dialog.querySelectorAll('button')]
            .map((node) => ({node, rect: node.getBoundingClientRect()}))
            .filter(({rect}) => rect.width > 0 && rect.height > 0)
            .filter(({rect}) => rect.top < bounds.top + 90 && rect.left > bounds.left + bounds.width / 2)
            .sort((left, right) => left.rect.width * left.rect.height - right.rect.width * right.rect.height)[0];
          if (candidate) {
            candidate.node.click();
            clicked = true;
          }
        }
      }
      return {done: false, clicked, preview, onboarding, dialogs: visibleDialogs.length};
    })()`).catch(() => ({done: false, clicked: false}));
    if (state.done === true) return true;
    if (state.clicked !== true) {
      // Fall back to Escape for host dialogs that only close on the keyboard.
      win.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Escape'});
      win.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Escape'});
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  return false;
}

app.whenReady().then(async () => {
  const result = {ok: false, url, steps: {}};
  try {
    const win = new BrowserWindow({
      show: false,
      width: 1400,
      height: 900,
      webPreferences: {contextIsolation: true, sandbox: false, backgroundThrottling: false},
    });
    win.webContents.on('console-message', (_event, level, message) => {
      const text = String(message).slice(0, 400);
      if (text.includes('Electron Security Warning')) return;
      consoleLines.push({level, message: text});
    });
    await win.loadURL(url);
    result.steps.pageLoaded = true;
    result.steps.sidebarEntry = await waitFor(win, "document.body && document.body.innerText.includes('本地工作台')", 60000);
    // A fresh isolated DSH_HOME shows the product's own first-run preview notice;
    // dismiss it so the workbench panel is fully visible in the evidence image.
    result.steps.firstRunNoticeDismissed = await dismissProductNotice(win);
    await new Promise((resolve) => setTimeout(resolve, 300));
    result.clickedOpen = await win.webContents.executeJavaScript(clickWorkbenchEntry());
    result.steps.panelReady = await waitFor(win, "document.body.innerText.includes('fixture 组合')", 30000);
    if (result.steps.panelReady) await new Promise((resolve) => setTimeout(resolve, 3000));
    result.panelText = await win.webContents.executeJavaScript('document.body.innerText.slice(0, 8000)');
    result.panelDom = await win.webContents.executeJavaScript(`(() => ({
      cards: [...document.querySelectorAll('[class*="lw-card"]')].map((node) => node.innerText.slice(0, 240)).filter(Boolean).slice(0, 8),
      fixtureBanner: document.body.innerText.includes('fixture 组合（非真实能力）'),
      hasReturnButton: [...document.querySelectorAll('button')].some((node) => node.textContent.includes('返回聊天')),
      workbenchTitle: [...document.querySelectorAll('h1,h2,h3')].map((node) => node.textContent).filter((text) => text.includes('本地工作台')),
      liveRegion: document.querySelectorAll('[aria-live]').length,
      errorSummary: [...document.querySelectorAll('[role="alert"]')].map((node) => node.innerText.slice(0, 200)),
      hostOnboardingPresent: document.body.textContent.includes('开始使用'),
    }))()`);
    result.steps.returnToChat = await win.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('button')].find((node) => node.textContent.includes('返回聊天'));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    result.steps.chatRestored = await waitFor(win, "!document.body.innerText.includes('fixture 组合') && [...document.querySelectorAll('button')].some((node) => node.textContent.includes('新会话'))", 15000);
    result.clickedReopen = await win.webContents.executeJavaScript(clickWorkbenchEntry());
    result.steps.panelReopened = await waitFor(win, "document.body.innerText.includes('fixture 组合')", 15000);
    if (result.steps.panelReopened) await new Promise((resolve) => setTimeout(resolve, 1500));
    // The product's own first-run preview notice can appear after the shell
    // settles; dismiss it right before the evidence capture so the workbench
    // panel is fully visible.
    result.steps.noticeDismissedBeforeCapture = await dismissProductNotice(win);
    await new Promise((resolve) => setTimeout(resolve, 500));
    result.finalOverlay = await win.webContents.executeJavaScript(`(() => ({
      onboardingVisible: document.body.innerText.includes('开始使用'),
      previewVisible: document.body.innerText.includes('预览版说明'),
    }))()`);
    try {
      const image = await win.webContents.capturePage();
      writeFileSync(shot, image.toPNG());
      result.screenshot = shot;
    } catch (error) {
      result.screenshotError = String(error.message ?? error);
    }
    result.consoleLines = consoleLines.slice(0, 100);
    result.ok = result.steps.pageLoaded === true
      && result.steps.sidebarEntry === true
      && result.steps.panelReady === true
      && result.panelDom.fixtureBanner === true
      && result.panelDom.hasReturnButton === true
      && result.steps.returnToChat === true
      && result.steps.chatRestored === true
      && result.steps.panelReopened === true;
    finish(result);
  } catch (error) {
    result.error = String(error && error.message ? error.message : error);
    result.consoleLines = consoleLines.slice(0, 100);
    finish(result);
  }
});

setTimeout(() => {
  finish({ok: false, timeout: true, steps: {}, consoleLines: consoleLines.slice(0, 100)});
}, 180000);
