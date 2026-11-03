const ENGLISH = "com.apple.keylayout.ABC";

let cachedSource = null;
let keyTap = null;

function syncSource() {
  cachedSource = hs.keycodes.currentSourceID();
}

function convertToEnglish() {
  if (cachedSource !== ENGLISH && hs.keycodes.setSourceID(ENGLISH)) {
    syncSource();
  }
}

function stop() {
  if (keyTap) {
    hs.eventtap.removeWatcher(keyTap);
    keyTap = null;
  }
  hs.keycodes.off("change", syncSource);
}

function setup() {
  stop();
  syncSource();
  hs.keycodes.on("change", syncSource);

  const keyC = hs.keycodes.map.c;
  const keyH = hs.keycodes.map.h;
  const key1 = hs.keycodes.map["1"];

  // 오른쪽 Cmd/Ctrl 전환은 기존 Lua 설정처럼 비활성 상태로 둡니다.
  keyTap = hs.eventtap.addWatcher(
    [hs.eventtap.eventTypes.keyDown],
    (event) => {
      const keyCode = event.keyCode;
      if (keyCode !== keyC && keyCode !== keyH && keyCode !== key1) {
        return hs.eventtap.emit;
      }

      const flags = event.flags;
      const ctrl = flags.includes("ctrl");
      const cmd = flags.includes("cmd");
      const alt = flags.includes("alt");
      const shift = flags.includes("shift");

      const controlShortcut =
        (keyCode === keyC || keyCode === keyH) && ctrl && !cmd && !alt && !shift;
      const numberShortcut = keyCode === key1 && alt !== cmd && !ctrl && !shift;

      if (controlShortcut || numberShortcut) {
        convertToEnglish();
      }

      // 입력 소스만 바꾸고 원래 단축키는 대상 앱에 전달합니다.
      return hs.eventtap.emit;
    },
    false,
  );

  if (keyTap) {
    keyTap.start();
  }
  if (!keyTap || !keyTap.isEnabled()) {
    console.warn(
      "입력 소스 단축키를 시작하지 못했습니다. Hammerspoon 2의 손쉬운 사용 권한을 허용한 뒤 Reload Config를 실행하세요.",
    );
  }
}

module.exports = { setup, stop };
