const EXOSPHERE = "com.exosphere.Exosphere";
// 기존 Lua 설정의 마지막 마우스 복귀 대기 시간(초)을 유지합니다.
const MOUSE_RESTORE_DELAY_SECONDS = 1000;

function delay(seconds) {
  return new Promise((resolve) => hs.timer.doAfter(seconds, resolve));
}

function isExosphereActive() {
  const app = hs.application.matchingBundleID(EXOSPHERE);
  return app !== null && app.isActive;
}

async function waitForExosphere() {
  const deadline = hs.timer.secondsSinceEpoch() + 5;
  while (!isExosphereActive()) {
    if (hs.timer.secondsSinceEpoch() >= deadline) {
      return false;
    }
    await delay(0.1);
  }
  return true;
}

async function runAutomation() {
  const finder = hs.application.matchingBundleID("com.apple.finder");
  if (!finder || !finder.isActive) {
    hs.ui.alert("Finder가 활성화되어 있지 않습니다").show();
    return;
  }

  const initialMousePosition = hs.mouse.absolutePosition();
  try {
    hs.eventtap.rightClick(initialMousePosition.x, initialMousePosition.y);
    await delay(0.1);
    for (const key of ["e", "right", "t", "return"]) {
      hs.eventtap.keyStroke([], key);
    }
    await delay(0.5);

    if (!(await waitForExosphere())) {
      hs.ui.alert("Exosphere 프로그램을 찾을 수 없습니다").show();
      return;
    }

    const actions = [
      ["t", 0.3],
      ["i", 0.3],
      ["o", MOUSE_RESTORE_DELAY_SECONDS],
    ];
    for (const [key, waitSeconds] of actions) {
      if (!isExosphereActive()) {
        throw new Error("Exosphere가 활성화되어 있지 않습니다");
      }
      hs.eventtap.keyStroke(["shift", "cmd"], "space");
      await delay(0.2);
      if (!isExosphereActive()) {
        throw new Error("Exosphere가 활성화되어 있지 않습니다");
      }
      hs.eventtap.keyStroke([], key);
      hs.eventtap.keyStroke([], "return");
      await delay(waitSeconds);
    }
  } finally {
    hs.mouse.setAbsolutePosition(initialMousePosition.x, initialMousePosition.y);
  }
}

function setup() {
  hs.hotkey.bind(["cmd", "shift"], "x", () => {
    runAutomation().catch((error) => {
      console.error(`Exosphere 자동화 실패: ${error}`);
      hs.ui.alert("Exosphere 자동화에 실패했습니다. 콘솔을 확인하세요.").show();
    });
  });
}

module.exports = { setup };
