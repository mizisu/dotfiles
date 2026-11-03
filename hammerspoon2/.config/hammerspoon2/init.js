const inputSource = require("./modules/input-source");
const appShortcut = require("./modules/app-shortcut");
const exosphere = require("./modules/exosphere");

inputSource.setup();
appShortcut.setup();
exosphere.setup();

console.log("Hammerspoon 2 설정을 불러왔습니다.");
