const { app, BrowserWindow, Menu, dialog } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const http = require('http');

let mainWindow;
let serverProcess;
const PORT = process.env.PORT || 3000;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'AI-Multiagent',
    icon: path.join(__dirname, 'build/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  Menu.setApplicationMenu(null);

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

// 외부 모듈 없이 http 폴링으로 서버 준비 감지
function waitForServer(port, timeout = 20000, interval = 500) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function check() {
      const req = http.get(`http://localhost:${port}`, (res) => {
        req.destroy();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeout) {
          reject(new Error(`서버가 ${timeout / 1000}초 안에 시작되지 않았습니다.`));
        } else {
          setTimeout(check, interval);
        }
      });
      req.setTimeout(400, () => { req.destroy(); });
    }
    setTimeout(check, 800);
  });
}

app.on('ready', async () => {
  // 1. 먼저 로딩 창을 즉시 표시
  createWindow();
  mainWindow.loadURL(`data:text/html,<html><body style="background:#0f172a;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;color:#94a3b8;"><div style="text-align:center"><h2 style="color:#a78bfa">AI-Multiagent</h2><p>서버 시작 중...</p></div></body></html>`);

  // 2. 메인 프로세스에서 Express 서버 직접 실행 (ASAR 지원 유지)
  const userDataDir = app.getPath('userData');
  process.env.PORT = String(PORT);
  process.env.HEADLESS = 'false';
  process.env.APP_DATA_DIR = userDataDir;

  try {
    require('./src/api/server.js');
  } catch (err) {
    dialog.showErrorBox('서버 실행 오류', `서버 코드를 불러오지 못했습니다:\n${err.message}`);
    app.quit();
    return;
  }

  try {
    // 3. 서버 준비 대기 후 UI 로드
    await waitForServer(PORT);
    if (mainWindow) {
      mainWindow.loadURL(`http://localhost:${PORT}`);
    }
  } catch (err) {
    dialog.showErrorBox('연결 오류', `서버에 연결할 수 없습니다.\n\n${err.message}\n\n앱을 다시 실행해 주세요.`);
    app.quit();
  }
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', function () {
  if (mainWindow === null) {
    createWindow();
    mainWindow.loadURL(`http://localhost:${PORT}`);
  }
});
