function setup() {
  const apps = [
    ["1", "com.mitchellh.ghostty", "Ghostty"],
    ["2", "com.google.Chrome", "Google Chrome"],
    ["3", "com.tinyspeck.slackmacgap", "Slack"],
  ];

  for (const [key, bundleID, name] of apps) {
    hs.hotkey.bind(["cmd", "shift"], key, () => {
      hs.application.launchOrFocus(bundleID).then((success) => {
        if (!success) {
          hs.ui.alert(`${name}을 실행할 수 없습니다.`).show();
        }
      }).catch((error) => {
        console.error(`${name} 실행 실패: ${error}`);
      });
    });
  }

  hs.hotkey.bind(["cmd", "shift"], "g", () => {
    hs.urlevent.openURL("https://calendar.google.com/");
  });
}

module.exports = { setup };
